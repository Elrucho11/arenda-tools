/* =========================================================
   Конфигурация общей облачной базы (Supabase).
   Пока пусто — приложение работает локально на каждом устройстве.
   После создания проекта Supabase сюда вставляются 2 значения:
     SUPABASE_URL       — Project URL  (Settings → Data API)
     SUPABASE_ANON_KEY  — публичный ключ "anon"/"publishable"
   Эти значения безопасно держать в открытом коде (доступ ограничен правилами базы).
   ========================================================= */
window.APP_CONFIG = {
  SUPABASE_URL: 'https://ffkeubeudfqeuehwbbpe.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_fiqwgj26OG_BcV-S3gA2Tg_XT3cRMJf',
  // Облачное распознавание паспорта (Supabase Edge Function → Claude API).
  // Пустая строка = выключено, работает только локальный OCR.
  CLOUD_OCR_URL: 'https://ffkeubeudfqeuehwbbpe.supabase.co/functions/v1/passport-ocr',
};
