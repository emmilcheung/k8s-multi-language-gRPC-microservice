// app/auth/signin/page.tsx

import { AuthForm } from "@/components/auth-form";
import { signin } from "@/app/actions/auth";

export const metadata = { title: "Sign In — Ticketing" };

export default function SigninPage() {
  return (
    <div className="min-h-[70vh] flex flex-col justify-center items-center py-12">
      {/* Radial glow behind card */}
      <div
        aria-hidden
        className="pointer-events-none absolute -z-10 h-[400px] w-[400px] rounded-full bg-primary/8 blur-[80px]"
      />
      <AuthForm mode="signin" action={signin} />
    </div>
  );
}
