import { AuthForm } from "@/components/auth-form";
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
    <div className="min-h-[70vh] flex flex-col justify-center items-center py-12">
      <AuthForm mode="signin" action={signin} next={next} />
    </div>
  );
}
