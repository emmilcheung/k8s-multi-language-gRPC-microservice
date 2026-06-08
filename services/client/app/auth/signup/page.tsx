// app/auth/signup/page.tsx

import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { signup } from "@/app/actions/auth";

export const metadata = { title: "Sign Up — Ticketing" };

export default function SignupPage() {
  return (
    <AuthShell>
      <AuthForm mode="signup" action={signup} />
    </AuthShell>
  );
}
