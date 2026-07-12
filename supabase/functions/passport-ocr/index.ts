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
// кадра. В кадре могут лежать посторонние бумаги, поэтому сбор начинается
// только от якоря «Паспорт выдан» или от строки с названием органа
// (УМВД/УФМС/ОТДЕЛ…), мусорные вставки пропускаются, а результат обязан
// содержать ключевое слово органа — иначе честный null.
function extractIssuedBy(fullText: string): string | null {
  const lines = fullText.split("\n").map((l) => l.trim()).filter(Boolean);
  const cyr = (s: string) => s.replace(/[^а-яёА-ЯЁ]/g, "").length;
  const KEY = /(УМВД|ГУ\s?МВД|МВД|УВД|ГУВД|УФМС|ОУФМС|ФМС|ОВД|РОВД|ПОЛИЦИ|МИЛИЦИ|ОТДЕЛ|МИГРАЦ|КОНСУЛ|ПОСОЛЬСТ|ВНУТРЕННИХ\s+ДЕЛ|ПАСПОРТНО)/i;
  const BOUND = /дата\s*выдачи|код\s*подразделения|личн(ый|ая)|подпись|фамилия|^имя\b|отчество|место\s*рожд|дата\s*рожд|^пол\b/i;
  const junk = (line: string) =>
    cyr(line) < 4 ||                                        // «41», «990553»
    /^(?:[а-яёА-ЯЁ]\s+){2,}[а-яёА-ЯЁ]$/.test(line) ||       // «Ф Е Д Е Р А Ц И Я»
    line.replace(/\D/g, "").length > cyr(line);             // цифр больше, чем букв

  const collect = (start: number) => {
    const out: string[] = [];
    for (let i = start; i < lines.length && out.length < 5; i++) {
      const line = lines[i];
      const low = line.toLowerCase();
      if (BOUND.test(low)) break;
      if (/^\d{2}\.\d{2}\.\d{4}/.test(line) || /^\d{3}-\d{3}$/.test(line)) break;
      if (/^[A-Z0-9<]{20,}$/.test(line.replace(/\s/g, ""))) break; // МЧЗ
      if (/российская|федерация|паспорт\s*выдан/.test(low)) continue;
      if (junk(line)) continue;
      out.push(line);
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  };

  // 1) от якоря «Паспорт выдан»
  const a = lines.findIndex((l) => /паспорт\s*выдан/i.test(l));
  if (a !== -1) {
    const t = collect(a);
    if (t.length >= 8 && KEY.test(t)) return t;
  }
  // 2) от первой строки с названием органа
  const k = lines.findIndex((l) => KEY.test(l) && !junk(l));
  if (k !== -1) {
    const t = collect(k);
    if (t.length >= 8 && KEY.test(t)) return t;
  }
  return null;
}

// ФИО из первой строки МЧЗ (PNRUS…) — спасает боковые/захламлённые фото,
// где модель теряет печатные поля, но МЧЗ читается.
const MRZ_CYR: Record<string, string> = {
  A: "А", B: "Б", V: "В", G: "Г", D: "Д", E: "Е", "2": "Ё", J: "Ж", Z: "З", I: "И",
  Q: "Й", K: "К", L: "Л", M: "М", N: "Н", O: "О", P: "П", R: "Р", S: "С", T: "Т",
  U: "У", F: "Ф", H: "Х", C: "Ц", "3": "Ч", "4": "Ш", W: "Щ", X: "Ъ", Y: "Ы",
  "9": "Ь", "6": "Э", "8": "Ю", "7": "Я",
};
const mrzWordToCyr = (s: string) => {
  const w = [...s].map((c) => MRZ_CYR[c] ?? "").join("");
  return w ? w[0] + w.slice(1).toLowerCase() : "";
};
function parseMrzNameFromText(fullText: string) {
  const lines = fullText.toUpperCase().split("\n")
    .map((l) => l.replace(/[^A-Z0-9<]/g, "")).filter((l) => l.length >= 20);
  for (const raw of lines) {
    const i = raw.search(/P[NM]RU[S5]/);
    if (i === -1) continue;
    const rest = raw.slice(i + 5).replace(/<+$/, ""); // отрезать хвостовые заполнители
    // между фамилией и именем — «<<», но OCR может съесть один «<»
    let tokens: string[];
    if (rest.includes("<<")) {
      const [surname, given = ""] = rest.split("<<");
      tokens = [surname, ...given.split("<").filter(Boolean)];
    } else {
      tokens = rest.split("<").filter(Boolean);
    }
    const last = mrzWordToCyr(tokens[0] ?? "");
    const first = mrzWordToCyr(tokens[1] ?? "");
    const middle = mrzWordToCyr(tokens[2] ?? "");
    if (last.length >= 2 && first.length >= 2) return { last, first, middle };
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

// Разбор штампа «ЗАРЕГИСТРИРОВАН» (5-я страница): печатные подписи полей +
// рукописные значения. Собираем адрес из строк с метками Рег-н / Р-н / Пункт /
// ул. / дом №; значение может оказаться и на следующей строке после метки.
function parseRegistration(fullText: string) {
  const rawLines = fullText.split("\n").map((l) => l.trim()).filter(Boolean);
  // Обычно штамп начинается с «ЗАРЕГИСТРИРОВАН», но при боковом фото это
  // вертикальное слово может попасть в текст ПОСЛЕ полей — пробуем оба варианта
  // и берём тот, где полей собралось больше.
  const start = rawLines.findIndex((l) => /зарегистрирован/i.test(l));
  const sliced = start >= 0 ? rawLines.slice(start) : rawLines;
  let best = parseRegistrationLines(sliced);
  if (start > 0) {
    const b = parseRegistrationLines(rawLines);
    if (b.found > best.found) best = b;
  }
  if (best.found >= 2) return { reg_address: best.reg_address, confidence: best.confidence };

  // Городские штампы без меток: «ЗАРЕГИСТРИРОВАН по адресу: г. Москва, ул. …»
  const cyr = (s: string) => s.replace(/[^а-яёА-ЯЁ]/g, "").length;
  const ai = rawLines.findIndex((l) => /по\s+адресу/i.test(l));
  if (ai !== -1) {
    const first = rawLines[ai].replace(/^[\s\S]*?по\s+адресу[:\s]*/i, "").trim();
    const parts: string[] = first ? [first] : [];
    for (let i = ai + 1; i < rawLines.length && parts.length < 4; i++) {
      const l = rawLines[i];
      if (/отдел|мвд|уфмс|фмс|полиц|подпись|фамилия|зарегистрирован/i.test(l)) break;
      if (/^\d{2}\.\d{2}\.\d{4}/.test(l)) break;
      if (cyr(l) < 3 && !/\d/.test(l)) continue;
      parts.push(l);
    }
    const addr = parts.join(", ").replace(/\s+/g, " ").replace(/,\s*,/g, ",").trim();
    if (addr.length >= 8) {
      return { reg_address: addr, confidence: "medium" };
    }
  }
  return { reg_address: best.reg_address, confidence: best.confidence };
}

function parseRegistrationLines(lines: string[]) {
  const clean = (s: string) =>
    s.replace(/[_]+/g, " ").replace(/\s+/g, " ").replace(/^[\s:.,\-—]+|[\s:.,\-—]+$/g, "").trim();
  const isLabelOnly = (s: string) => !clean(s);

  let region = "", district = "", settlement = "", street = "";
  let house = "", building = "", flat = "";

  const grab = (line: string, re: RegExp): string | null => {
    const m = line.match(re);
    return m ? clean(m[1] ?? "") : null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = () => {
      const n = lines[i + 1] || "";
      // значение уехало на следующую строку, если та не очередная метка
      if (/рег|^р[\s.\-]?н|пункт|^ул|дом|корп|стр|^кв|отдел|мвд|подпись|фамилия/i.test(n)) return "";
      i++;
      return clean(n);
    };
    // NB: \W в JS считает кириллицу «не-словом» — используем явный класс разделителей
    const SEP = "[\\s:.,№«»_\\-—]*";
    let v: string | null;
    // метки бывают полные («Регион», «Район») и сокращённые («Рег-н», «Р-н»)
    if (!region && (v = grab(line, new RegExp(`^рег(?:ион|[^а-яёa-z0-9]{0,3}н)${SEP}(.*)`, "i"))) !== null) {
      region = v || next();
    } else if (!district && (v = grab(line, new RegExp(`^р(?:айон|[^а-яёa-z0-9]{0,3}н)${SEP}(.*)`, "i"))) !== null) {
      district = v || next();
    } else if (!settlement && (v = grab(line, new RegExp(`пункт${SEP}(.*)`, "i"))) !== null) {
      settlement = v || next();
    } else if (!street && (v = grab(line, new RegExp(`^ул${SEP}(.*)`, "i"))) !== null) {
      street = v || next();
    } else if (/дом/i.test(line)) {
      const h = line.match(new RegExp(`дом${SEP}([0-9]+[а-яёА-ЯЁa-z]?(?:[\\/-][0-9а-яёА-ЯЁ]+)?)`, "i"));
      if (h) house = h[1];
      const k = line.match(new RegExp(`корп${SEP}([0-9]+[а-яёА-ЯЁ]?)`, "i"));
      if (k) building = k[1];
      const f = line.match(new RegExp(`кв${SEP}([0-9]+)`, "i"));
      if (f) flat = f[1];
    } else if (!flat) {
      const f = line.match(new RegExp(`^кв${SEP}([0-9]+)`, "i"));
      if (f) flat = f[1];
    }
  }

  const parts: string[] = [];
  if (region) parts.push(region);
  if (district) parts.push(/р-?н|район/i.test(district) ? district : district + " р-н");
  if (settlement) parts.push(settlement);
  if (street) parts.push(/^(ул|пер|пр|б-р|мкр|проезд|шоссе)/i.test(street) ? street : "ул. " + street);
  if (house) parts.push("д. " + house);
  if (building) parts.push("корп. " + building);
  if (flat) parts.push("кв. " + flat);

  const address = parts.join(", ").replace(/\s+/g, " ").trim();
  const found = [region, district || settlement, street, house].filter(Boolean).length;
  return {
    reg_address: address.length >= 8 ? address : null,
    confidence: found >= 4 ? "high" : found >= 2 ? "medium" : "low",
    found,
  };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
  }

  try {
    // Распознавание доступно только вошедшим сотрудникам
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Требуется вход" }), { status: 401, headers: cors });
    }
    const uResp = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
      headers: {
        "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        "Authorization": `Bearer ${token}`,
      },
    });
    if (!uResp.ok) {
      return new Response(JSON.stringify({ error: "Требуется вход" }), { status: 401, headers: cors });
    }

    const apiKey = Deno.env.get("YANDEX_API_KEY");
    const folderId = Deno.env.get("YANDEX_FOLDER_ID");
    if (!apiKey || !folderId) {
      return new Response(
        JSON.stringify({ error: "YANDEX_API_KEY / YANDEX_FOLDER_ID не настроены" }),
        { status: 500, headers: cors },
      );
    }

    const { image, media_type, debug, mode } = await req.json();
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

    // Режим «прописка»: штамп «ЗАРЕГИСТРИРОВАН» — рукописный текст,
    // читаем моделью handwritten и собираем адрес по меткам полей.
    if (mode === "address") {
      const hwResp = await ycOcr("handwritten");
      if (!hwResp.ok) {
        const detail = await hwResp.text();
        return new Response(
          JSON.stringify({ error: `Yandex OCR ${hwResp.status}: ${detail.slice(0, 300)}` }),
          { status: 502, headers: cors },
        );
      }
      const hwPayload = await hwResp.json();
      const hwAnn = hwPayload?.result?.textAnnotation ?? hwPayload?.result?.text_annotation;
      const hwText: string = hwAnn?.fullText ?? hwAnn?.full_text ?? "";
      const reg = parseRegistration(hwText);
      const body: Record<string, unknown> = { data: reg };
      if (debug === true) body.debug = { fullText: hwText };
      return new Response(JSON.stringify(body), { headers: cors });
    }

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

    // ФИО из МЧЗ — добираем то, что модель не разглядела (боковые/захламлённые фото).
    // Печатные поля точнее (е/ё), поэтому заполняем только пропуски.
    const mrzName = parseMrzNameFromText(fullText);
    if (mrzName) {
      if (!data.last_name) data.last_name = mrzName.last;
      if (!data.first_name) data.first_name = mrzName.first;
      if (!data.middle_name && mrzName.middle) data.middle_name = mrzName.middle;
    }

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
