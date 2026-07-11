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

// «Кем выдан» не выделяется паспортной моделью — достаём из полного текста
// страницы (его даёт вторая, обычная текстовая модель). Название органа может
// быть разбито на несколько строк, между которыми OCR вклинивает мусор
// (вертикальные красные цифры серии, обрывки фона) — мусор пропускаем,
// сбор останавливаем только на настоящих границах.
function extractIssuedBy(fullText: string): string | null {
  const lines = fullText.split("\n").map((l) => l.trim()).filter(Boolean);
  const cyr = (s: string) => s.replace(/[^а-яёА-ЯЁ]/g, "").length;
  const HARD = /дата\s*выдачи|код\s*подразделения|личн(ый|ая)|подпись|фамилия|^имя\b|отчество|место\s*рожд|дата\s*рожд|^пол\b/i;

  const out: string[] = [];
  for (const line of lines) {
    const low = line.toLowerCase();
    if (HARD.test(low)) break;                                 // настоящая граница
    if (/^\d{2}\.\d{2}\.\d{4}/.test(line)) break;              // дата выдачи
    if (/^\d{3}-\d{3}$/.test(line)) break;                     // код подразделения
    if (/российская|федерация|паспорт\s*выдан/.test(low)) continue;
    if (cyr(line) < 4) continue;                               // «41», «990553» — мусор
    if (/^(?:[а-яёА-ЯЁ]\s+){2,}[а-яёА-ЯЁ]$/.test(line)) continue; // «Ф Е Д Е Р А Ц И Я»
    if (line.replace(/\D/g, "").length > cyr(line)) continue;  // цифр больше, чем букв
    out.push(line);
    if (out.length >= 5) break;                                // максимум несколько строк
  }
  const text = out.join(" ").replace(/\s+/g, " ").trim();
  if (text.length >= 8) return text;

  // Запасной способ: сегмент между «Паспорт выдан» и «Дата выдачи»/датой
  const seg = fullText.match(/паспорт\s*выдан([\s\S]*?)(дата\s*выдачи|код\s*подразделения|\d{2}\.\d{2}\.\d{4})/i);
  if (seg) {
    const t = seg[1].split("\n").map((l) => l.trim()).filter((l) => cyr(l) >= 4)
      .join(" ").replace(/\s+/g, " ").trim();
    if (t.length >= 8) return t;
  }
  return null;
}

// Разбор второй строки МЧЗ из распознанного текста: серия/номер/даты/код
// с проверкой контрольных цифр (веса 7-3-1). Надёжнее «визуальной» догадки модели.
function parseMrzFromText(fullText: string) {
  const lines = fullText.toUpperCase().split("\n")
    .map((l) => l.replace(/[^A-Z0-9<]/g, "")).filter((l) => l.length >= 25);
  let l2 = "";
  for (const l of lines) {
    const norm = l.replace(/O/g, "0").replace(/[IL]/g, "1");
    if (/^\d{7}/.test(norm) && l.replace(/5/g, "S").includes("RUS")) { l2 = l; break; }
  }
  if (!l2) return null;
  const a2 = l2.replace(/5/g, "S").indexOf("RUS");
  if (a2 >= 10) l2 = l2.slice(a2 - 10);
  l2 = l2.padEnd(44, "<");
  const dig = (s: string) => s.replace(/[OQ]/g, "0").replace(/[IL]/g, "1").replace(/B/g, "8")
    .replace(/S/g, "5").replace(/Z/g, "2").replace(/G/g, "6");
  const docField = dig(l2.slice(0, 9));
  const birth = dig(l2.slice(13, 19));
  if (!/^\d{9}$/.test(docField) || !/^\d{6}$/.test(birth)) return null;
  const check = (s: string) => [...s].reduce((sum, c, i) =>
    sum + (c === "<" ? 0 : (c >= "0" && c <= "9" ? +c : c.charCodeAt(0) - 55)) * [7, 3, 1][i % 3], 0) % 10;
  const valid = check(l2.slice(0, 9)) === +dig(l2[9]) && check(l2.slice(13, 19)) === +dig(l2[19]);
  // Личное поле: и по позиции 29–42, и по якорю «цифры после заполнителей» —
  // выбираем вариант с правдоподобной датой выдачи (лечит съеденный «<»)
  const cands = [dig(l2.slice(28, 41))];
  const am = l2.slice(20).match(/<+([0-9OQILBSZG]{7,13})/);
  if (am) cands.push(dig(am[1]));
  let best = cands[0], bestScore = -1;
  for (const p of cands) {
    const is = p.slice(1, 7), mm = +is.slice(2, 4), dd = +is.slice(4, 6);
    let score = 0;
    if (/^\d/.test(p)) score += 1;
    if (/^\d{6}$/.test(is) && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) score += 2;
    if (/^\d{6}$/.test(p.slice(7, 13))) score += 1;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  const series4 = /^\d/.test(best) ? best[0] : "";
  const issue = best.slice(1, 7), dept = best.slice(7, 13);
  const iso = (yymmdd: string, pivot: number) => {
    if (!/^\d{6}$/.test(yymmdd)) return null;
    const yy = +yymmdd.slice(0, 2), mm = +yymmdd.slice(2, 4), dd = +yymmdd.slice(4, 6);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${yy > pivot ? 1900 + yy : 2000 + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  };
  return {
    valid,
    series: docField.slice(0, 3) + series4,
    number: docField.slice(3, 9),
    birth_date: iso(birth, new Date().getFullYear() % 100),
    issue_date: iso(issue, 96),
    dept_code: /^\d{6}$/.test(dept) ? dept.slice(0, 3) + "-" + dept.slice(3) : null,
  };
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

    const { image, media_type, debug } = await req.json();
    if (!image || typeof image !== "string") {
      return new Response(JSON.stringify({ error: "нет изображения" }), { status: 400, headers: cors });
    }

    // Два параллельных запроса: «passport» даёт разобранные поля,
    // «page» — полный текст страницы (нужен для «Кем выдан»: паспортная
    // модель fullText не возвращает).
    const ycOcr = (model: string) =>
      fetch("https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText", {
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
          model,
          content: image,
        }),
      });

    const [passResp, pageResp] = await Promise.all([ycOcr("passport"), ycOcr("page")]);

    if (!passResp.ok) {
      const detail = await passResp.text();
      return new Response(
        JSON.stringify({ error: `Yandex OCR ${passResp.status}: ${detail.slice(0, 300)}` }),
        { status: 502, headers: cors },
      );
    }

    const payload = await passResp.json();
    const annotation = payload?.result?.textAnnotation ?? payload?.result?.text_annotation;
    if (!annotation) {
      return new Response(JSON.stringify({ error: "пустой ответ Yandex OCR" }), {
        status: 502, headers: cors,
      });
    }

    // Полный текст: из «page», при неудаче — что есть у «passport»
    let pageText = "";
    if (pageResp.ok) {
      const pagePayload = await pageResp.json().catch(() => null);
      const pageAnn = pagePayload?.result?.textAnnotation ?? pagePayload?.result?.text_annotation;
      pageText = pageAnn?.fullText ?? pageAnn?.full_text ?? "";
    }

    const entities: Record<string, string> = {};
    for (const e of annotation.entities ?? []) {
      if (e?.name && e?.text && e.text !== "-") entities[e.name] = String(e.text).trim();
    }

    const digits = (entities.number || "").replace(/\D/g, "");
    const fullText: string = pageText || annotation.fullText || annotation.full_text || "";
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

    // МЧЗ с сошедшимися контрольными цифрами перекрывает визуальную догадку модели
    const mrz = parseMrzFromText(fullText);
    if (mrz && mrz.valid) {
      if (mrz.series.length === 4 && /^\d{6}$/.test(mrz.number)) {
        data.series = mrz.series;
        data.number = mrz.number;
      }
      if (mrz.birth_date) data.birth_date = mrz.birth_date;
      if (mrz.issue_date) data.issue_date = mrz.issue_date;
      if (mrz.dept_code) data.dept_code = mrz.dept_code;
    } else if (mrz) {
      // контрольные цифры не сошлись — только дозаполняем пустое
      if (!data.series && mrz.series.length === 4) { data.series = mrz.series; data.number = mrz.number; }
      if (!data.birth_date) data.birth_date = mrz.birth_date;
      if (!data.issue_date) data.issue_date = mrz.issue_date;
      if (!data.dept_code) data.dept_code = mrz.dept_code;
    }

    // Ключевые поля не распознались — честно понижаем уверенность
    const key = [data.last_name, data.first_name, data.series, data.number, data.issue_date, data.birth_date];
    const missing = key.filter((v) => !v).length;
    if (missing >= 3) data.confidence = "low";
    else if (missing > 0 || !data.dept_code) data.confidence = "medium";
    else if (mrz && mrz.valid) data.confidence = "high";

    const body: Record<string, unknown> = { data };
    if (debug === true) {
      body.debug = { entities: annotation.entities ?? [], fullText };
    }
    return new Response(JSON.stringify(body), { headers: cors });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: cors });
  }
});
