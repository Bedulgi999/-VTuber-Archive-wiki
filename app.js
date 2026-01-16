document.addEventListener("DOMContentLoaded", () => {

const SUPABASE_URL = "https://wzbjbiaiumonyvucewqi.supabase.co";
const SUPABASE_ANON_KEY =
"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6YmpiaWFpdW1vbnl2dWNld3FpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0NDAxMTUsImV4cCI6MjA4NDAxNjExNX0.DFmuUKBRDCDkE5zHF5zH9GLU8Wd-IGFIbLwO-5gJC3o";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth:{
    storageKey:"vtwiki-auth-token",
    persistSession:true,
    autoRefreshToken:true,
    detectSessionInUrl:true
  }
});

const toast=(t,m)=>alert(t+"\n"+m);
const isEmailConfirmError=e=>String(e?.message||"").toLowerCase().includes("confirm");

async function ensureProfile(u){
  if(!u?.id) return;
  await sb.from("profiles").upsert({
    id:u.id,
    email:u.email,
    display_name:u.email?.split("@")[0]||"user"
  },{onConflict:"id"});
}

sb.auth.onAuthStateChange((ev,session)=>{
  if(ev==="SIGNED_IN" && session?.user){
    ensureProfile(session.user);
    toast("로그인 성공","환영합니다");
    loginModal.close();
  }
});

const btnLogin=document.getElementById("btnLogin");
const themeBtn=document.getElementById("themeBtn");
const loginModal=document.getElementById("loginModal");
const loginForm=document.getElementById("loginForm");
const loginEmail=document.getElementById("loginEmail");
const loginPassword=document.getElementById("loginPassword");
const closeLogin=document.getElementById("closeLogin");

btnLogin?.addEventListener("click",()=>loginModal.showModal());
closeLogin?.addEventListener("click",()=>loginModal.close());

loginForm?.addEventListener("submit",async e=>{
  e.preventDefault();
  const email=loginEmail.value.trim();
  const password=loginPassword.value.trim();
  const mode=document.querySelector('input[name="mode"]:checked').value;
  try{
    if(mode==="magic"){
      const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin}});
      if(error) throw error;
      toast("메일 전송","이메일을 확인하세요");
      return;
    }
    const {error}=await sb.auth.signInWithPassword({email,password});
    if(error){
      if(isEmailConfirmError(error)){
        await sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin}});
        toast("이메일 인증","인증 링크 전송됨");
        return;
      }
      throw error;
    }
  }catch(err){
    toast("로그인 실패",err.message||String(err));
  }
});

themeBtn?.addEventListener("click",()=>{
  const root=document.documentElement;
  root.dataset.theme=root.dataset.theme==="dark"?"light":"dark";
});

});