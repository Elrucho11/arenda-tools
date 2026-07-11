// Supabase Edge Function: распознавание паспорта РФ по фото через Яндекс Vision OCR
// (нейросетевая модель "passport" — специализирована под паспорт РФ, данные хранятся в РФ).
// Секреты (supabase secrets set ...):
//   YANDEX_API_KEY   — API-ключ сервисного аккаунта с ролью ai.vision.user
//   YANDEX_FOLDER_ID — идентификатор каталога в Яндекс Облаке
// Деплой: supabase functions deploy passport-ocr --no-verify-jwt

const ALLOWED_ORIGINS = [
  "https://elrucho11.github.io",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

// «елена» → «Елена», «петров-водкин» → «Петров-Водкин»
function titleCase(s: string | null): string | null {
  if (!s) return null;
  return s
    .toLowerCase()
    .replace(/(^|[\s-])([а-яёa-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

// «12.05.1978» → «1978-05-12»
function isoDate(s: string | null): string | null {
  const m = s && s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// «Кем выдан» не выделяется моделью отдельным полем — достаём из полного текста.
// Основной способ: сегмент между «Паспорт выдан» и «Дата выдачи»/датой.
// Запасной: строки верхней части страницы до первой служебной надписи.
function extractIssuedBy(fullText: string): string | null {
  const clean = (s: string) =>
    s.split("\n").map((l) => l.trim()).filter(Boolean)
      .filter((l) => l.replace(/[^а-яёА-ЯЁ]/g, "").length >= 3)
      .join(" ").replace(/\s+/g, " ").trim();

  const seg = fullText.match(/паспорт\s*выдан([\s\S]*?)(дата\s*выдачи|код\s*подразделения|\d{2}\.\d{2}\.\d{4})/i);
  if (seg) {
    const text = clean(seg[1]);
    if (text.length >= 8) return text;
  }

  const lines = fullText.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    if (/дата выдачи|код подразделения|личн(ый|ая)|подпись/.test(low)) break;
    if (/^\d{2}\.\d{2}\.\d{4}/.test(line) || /^\d{3}-\d{3}$/.test(line)) break;
    if (/фамилия|^имя|отчество|пол|место рождения|дата рождения/.test(low)) break;
    if (/российская федерация|паспорт выдан/.test(low)) continue;
    if (line.replace(/[^а-яёА-ЯЁ]/g, "").length < 3) continue;
    out.push(line);
    if (out.length >= 5) break; // «кем выдан» — максимум несколько строк
  }
  const text = out.join(" ").replace(/\s+/g, " ").trim();
  return text.length >= 8 ? text : null;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
  }

  try {
    const apiKey = Deno.env.get("YANDEX_API_KEY");
    const folderId = Deno.env.get("YANDEX_FOLDER_ID");
    if (!apiKey || !folderId) {
      return new Response(
        JSON.stringify({ error: "YANDEX_API_KEY / YANDEX_FOLDER_ID не настроены" }),
        { status: 500, headers: cors },
      );
    }

    const { image, media_type } = await req.json();
    if (!image || typeof image !== "string") {
      return new Response(JSON.stringify({ error: "нет изображения" }), { status: 400, headers: cors });
    }

    const yaResp = await fetch("https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText", {
      method: "POST",
      headers: {
        "Authorization": `Api-Key ${apiKey}`,
        "x-folder-id": folderId,
        "x-data-logging-enabled": "false", // не сохранять ПДн в логах Яндекса
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mimeType: media_type === "image/png" ? "PNG" : "JPEG",
        languageCodes: ["ru"],
        model: "passport",
        content: image,
      }),
    });

    if (!yaResp.ok) {
      const detail = await yaResp.text();
      return new Response(
        JSON.stringify({ error: `Yandex OCR ${yaResp.status}: ${detail.slice(0, 300)}` }),
        { status: 502, headers: cors },
      );
    }

    const payload = await yaResp.json();
    const annotation = payload?.result?.textAnnotation ?? payload?.result?.text_annotation;
    if (!annotation) {
      return new Response(JSON.stringify({ error: "пустой ответ Yandex OCR" }), {
        status: 502, headers: cors,
      });
    }

    const entities: Record<string, string> = {};
    for (const e of annotation.entities ?? []) {
      if (e?.name && e?.text && e.text !== "-") entities[e.name] = String(e.text).trim();
    }

    const digits = (entities.number || "").replace(/\D/g, "");
    const fullText: string = annotation.fullText ?? annotation.full_text ?? "";
    const subdivision = (entities.subdivision || "").replace(/\D/g, "");

    const data = {
      last_name: titleCase(entities.surname || null),
      first_name: titleCase(entities.name || null),
      middle_name: titleCase(entities.middle_name || null),
      series: digits.length === 10 ? digits.slice(0, 4) : null,
      number: digits.length === 10 ? digits.slice(4) : null,
      birth_date: isoDate(entities.birth_date || null),
      birth_place: entities.birth_place ? entities.birth_place.toUpperCase() : null,
      issue_date: isoDate(entities.issue_date || null),
      issued_by: extractIssuedBy(fullText),
      dept_code: subdivision.length === 6 ? subdivision.slice(0, 3) + "-" + subdivision.slice(3) : null,
      confidence: "high" as string,
    };

    // Ключевые поля не распознались — честно понижаем уверенность
    const key = [data.last_name, data.first_name, data.series, data.number, data.issue_date];
    const missing = key.filter((v) => !v).length;
    if (missing >= 3) data.confidence = "low";
    else if (missing > 0 || !data.dept_code) data.confidence = "medium";

    return new Response(JSON.stringify({ data }), { headers: cors });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: cors });
  }
});
