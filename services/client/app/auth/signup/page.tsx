// app/auth/signup/page.tsx

import { AuthForm } from "@/components/auth-form";
import { signup } from "@/app/actions/auth";

export const metadata = { title: "Sign Up — Ticketing" };

export default function SignupPage() {
  return (
    <div className="min-h-[70vh] flex flex-col justify-center items-center py-12">
      <AuthForm mode="signup" action={signup} />
    </div>
  );
}
