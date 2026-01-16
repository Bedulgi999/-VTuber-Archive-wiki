/***********************
 * Supabase init
 ***********************/
const SUPABASE_URL = "https://wzbjbiaiumonyvucewqi.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6YmpiaWFpdW1vbnl2dWNld3FpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0NDAxMTUsImV4cCI6MjA4NDAxNjExNX0.DFmuUKBRDCDkE5zHF5zH9GLU8Wd-IGFIbLwO-5gJC3o";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storageKey: "vtwiki-auth-token",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
window.sb = sb;

/***********************
 * Utils
 ***********************/
function toast(title, message) {
  alert(`${title}\n${message}`);
}

function isAbortError(err) {
  return err && err.name === "AbortError";
}

function isEmailConfirmError(err) {
  return String(err?.message || "").toLowerCase().includes("confirm");
}

/***********************
 * Profile auto-create
 ***********************/
async function ensureProfile(user) {
  if (!user?.id) return;

  await sb.from("profiles").upsert(
    {
      id: user.id,
      email: user.email,
      display_name: user.email
        ? user.email.split("@")[0]
        : "user",
    },
    { onConflict: "id" }
  );
}

/***********************
 * Auth state
 ***********************/
sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" && session?.user) {
    ensureProfile(session.user);
    toast("로그인 성공", "환영합니다!");
    document.getElementById("loginModal")?.close();
  }
});

/***********************
 * Login UI
 ***********************/
const loginModal = document.getElementById("loginModal");
const btnLogin = document.getElementById("btnLogin");
const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");

btnLogin.addEventListener("click", () => {
  loginModal.showModal();
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = loginEmail.value.trim();
  const password = loginPassword.value.trim();
  const mode = document.querySelector(
    'input[name="mode"]:checked'
  ).value;

  try {
    // 매직링크 로그인
    if (mode === "magic") {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: location.origin },
      });
      if (error) throw error;

      toast("메일 전송", "이메일로 로그인 링크를 보냈어요.");
      return;
    }

    // 비밀번호 로그인
    const { error } = await sb.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      if (isEmailConfirmError(error)) {
        await sb.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: location.origin },
        });
        toast(
          "이메일 인증 필요",
          "인증 링크를 이메일로 보냈어요."
        );
        return;
      }
      throw error;
    }
  } catch (err) {
    if (isAbortError(err)) return;
    toast("로그인 실패", err.message || String(err));
  }
});

/***********************
 * Theme toggle
 ***********************/
const themeBtn = document.getElementById("themeBtn");
themeBtn.addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme =
    root.dataset.theme === "dark" ? "light" : "dark";
});
