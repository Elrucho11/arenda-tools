// Supabase Edge Function: управление аккаунтами сотрудников.
// Работает через service-role ключ (автоматически доступен в окружении функций).
// Действия:
//   status         — {needsBootstrap} — есть ли хоть один аккаунт (без авторизации)
//   bootstrap      — создать ПЕРВЫЙ аккаунт (становится администратором); работает
//                    только пока в системе нет ни одного профиля
//   create         — создать сотрудника (только админ)
//   list           — список сотрудников (только админ)
//   set_role       — сменить роль (только админ; нельзя разжаловать последнего админа)
//   reset_password — задать новый пароль сотруднику (только админ)
//   delete         — удалить аккаунт (только админ; нельзя удалить последнего админа)
// Деплой: supabase functions deploy admin-users --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";

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

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function profilesCount(): Promise<number> {
  const { count, error } = await admin.from("profiles").select("id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function adminsCount(): Promise<number> {
  const { count, error } = await admin.from("profiles")
    .select("id", { count: "exact", head: true }).eq("role", "admin");
  if (error) throw error;
  return count ?? 0;
}

// Кто вызывает? Проверяем JWT и роль в profiles
async function caller(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: prof } = await admin.from("profiles").select("id,role,name").eq("id", data.user.id).single();
  return prof ? { userId: data.user.id, role: prof.role, name: prof.name } : null;
}

async function createAccount(email: string, password: string, name: string, role: string) {
  if (!email || !password || password.length < 6) throw new Error("Почта и пароль (от 6 символов) обязательны");
  if (!name || !name.trim()) throw new Error("Имя обязательно");
  const r = role === "admin" ? "admin" : "manager";
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name },
  });
  if (error) throw new Error(error.message);
  const { error: pe } = await admin.from("profiles").insert({
    id: data.user.id, email, name: name.trim(), role: r,
  });
  if (pe) { // профиль не создался — откатываем пользователя
    await admin.auth.admin.deleteUser(data.user.id).catch(() => {});
    throw new Error(pe.message);
  }
  return { id: data.user.id, email, name: name.trim(), role: r };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: cors });
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: cors });

  try {
    const body = await req.json();
    const action = body.action;

    if (action === "status") {
      return json({ needsBootstrap: (await profilesCount()) === 0 });
    }

    if (action === "bootstrap") {
      if ((await profilesCount()) > 0) return json({ error: "Администратор уже создан" }, 403);
      const acc = await createAccount(body.email, body.password, body.name, "admin");
      return json({ ok: true, account: acc });
    }

    // всё остальное — только администратор
    const who = await caller(req);
    if (!who) return json({ error: "Требуется вход" }, 401);
    if (who.role !== "admin") return json({ error: "Только для администратора" }, 403);

    if (action === "list") {
      const { data, error } = await admin.from("profiles")
        .select("id,email,name,role,created_at").order("created_at", { ascending: true });
      if (error) throw error;
      return json({ users: data });
    }

    if (action === "create") {
      const acc = await createAccount(body.email, body.password, body.name, body.role);
      return json({ ok: true, account: acc });
    }

    if (action === "set_role") {
      const role = body.role === "admin" ? "admin" : "manager";
      if (role === "manager") {
        const { data: target } = await admin.from("profiles").select("role").eq("id", body.id).single();
        if (target?.role === "admin" && (await adminsCount()) <= 1) {
          return json({ error: "Нельзя разжаловать последнего администратора" }, 400);
        }
      }
      const { error } = await admin.from("profiles").update({ role }).eq("id", body.id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "reset_password") {
      if (!body.password || body.password.length < 6) return json({ error: "Пароль от 6 символов" }, 400);
      const { error } = await admin.auth.admin.updateUserById(body.id, { password: body.password });
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    if (action === "delete") {
      const { data: target } = await admin.from("profiles").select("role").eq("id", body.id).single();
      if (target?.role === "admin" && (await adminsCount()) <= 1) {
        return json({ error: "Нельзя удалить последнего администратора" }, 400);
      }
      const { error } = await admin.auth.admin.deleteUser(body.id);
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    return json({ error: "Неизвестное действие" }, 400);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
