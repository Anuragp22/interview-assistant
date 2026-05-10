"use client";

import { useState } from "react";
import { z } from "zod";
import Link from "next/link";
import Image from "next/image";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { auth } from "@/firebase/client";
import { Form } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { signIn, signUp } from "@/lib/actions/auth.action";
import FormField from "@/components/FormField";
import { cn } from "@/lib/utils";

const authFormSchema = (type: FormType) => {
  return z.object({
    name: type === "sign-up" ? z.string().min(3) : z.string().optional(),
    email: z.string().email(),
    password: z.string().min(3),
  });
};

const AuthForm = ({ type }: { type: FormType }) => {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const formSchema = authFormSchema(type);
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const togglePasswordVisibility = () => setShowPassword((prev) => !prev);

  const onSubmit = async (data: z.infer<typeof formSchema>) => {
    setLoading(true);
    try {
      if (type === "sign-up") {
        const { name, email, password } = data;
        const userCredential = await createUserWithEmailAndPassword(
          auth,
          email,
          password,
        );

        const result = await signUp({
          uid: userCredential.user.uid,
          name: name!,
          email,
          password,
        });

        if (!result.success) {
          toast.error(result.message);
          return;
        }

        toast.success("Account created. Please sign in.");
        router.push("/sign-in");
      } else {
        const { email, password } = data;
        const userCredential = await signInWithEmailAndPassword(
          auth,
          email,
          password,
        );

        const idToken = await userCredential.user.getIdToken();
        if (!idToken) {
          toast.error("Sign in failed. Please try again.");
          return;
        }

        await signIn({ email, idToken });

        toast.success("Welcome back.");
        router.push("/");
      }
    } catch (error) {
      console.log(error);
      toast.error("There was an error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const isSignIn = type === "sign-in";

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="card-border">
        <div className="flex flex-col gap-6 p-8 sm:p-10">
          {/* Brand */}
          <Link
            href="/"
            className="flex items-center gap-2 self-center"
            aria-label="JobVoice home"
          >
            <Image src="/logo.svg" alt="" height={28} width={32} />
            <span className="font-semibold tracking-tight text-fg-strong text-lg">
              JobVoice
            </span>
          </Link>

          {/* Heading */}
          <div className="flex flex-col gap-1.5 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
              {isSignIn ? "Welcome back" : "Create your account"}
            </h1>
            <p className="text-sm text-fg-muted">
              {isSignIn
                ? "Sign in to keep practicing interviews."
                : "Start practicing interviews with an AI in minutes."}
            </p>
          </div>

          {/* Form */}
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              {!isSignIn && (
                <FormField
                  control={form.control}
                  name="name"
                  label="Name"
                  placeholder="Your name"
                  type="text"
                />
              )}

              <FormField
                control={form.control}
                name="email"
                label="Email"
                placeholder="you@example.com"
                type="email"
              />

              <div className="relative">
                <FormField
                  control={form.control}
                  name="password"
                  label="Password"
                  placeholder={isSignIn ? "Your password" : "At least 3 characters"}
                  type={showPassword ? "text" : "password"}
                />
                <button
                  type="button"
                  onClick={togglePasswordVisibility}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className={cn(
                    "absolute right-2.5 top-[34px] flex items-center justify-center",
                    "size-7 rounded-md text-fg-muted hover:text-fg-strong",
                    "hover:bg-surface-3 transition-colors",
                  )}
                >
                  {showPassword ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="w-full mt-2 gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {isSignIn ? "Signing in…" : "Creating account…"}
                  </>
                ) : (
                  <>{isSignIn ? "Sign in" : "Create account"}</>
                )}
              </Button>
            </form>
          </Form>

          {/* Footer link */}
          <p className="text-center text-sm text-fg-muted pt-2 border-t border-border-subtle">
            <span className="block pt-4">
              {isSignIn ? "No account yet?" : "Already have one?"}{" "}
              <Link
                href={isSignIn ? "/sign-up" : "/sign-in"}
                className="font-medium text-accent hover:underline underline-offset-4"
              >
                {isSignIn ? "Create one" : "Sign in"}
              </Link>
            </span>
          </p>
        </div>
      </div>
    </div>
  );
};

export default AuthForm;
