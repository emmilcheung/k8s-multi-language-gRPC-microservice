import { AuthForm } from "@/components/auth-form";
import { signin } from "@/app/actions/auth";

export const metadata = { title: "Sign In — Marquee" };

export default function SigninPage() {
  return (
    <div className="min-h-[70vh] flex flex-col justify-center items-center py-12">
      <AuthForm mode="signin" action={signin} />
    </div>
  );
}
