import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { signin } from "@/app/actions/auth";

export const metadata = { title: "Sign In — Marquee" };

// searchParams is a Promise in Next.js 15 App Router
export default async function SigninPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <AuthShell>
      <AuthForm mode="signin" action={signin} next={next} />
    </AuthShell>
  );
}
