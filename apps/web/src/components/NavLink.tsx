"use client";

import type { ComponentProps } from "react";
import { Link, usePathname } from "@/i18n/navigation";

/** A nav link that marks the page you are on (aria-current), for screen readers and the eye. */
export function NavLink({ href, ...rest }: ComponentProps<typeof Link> & { href: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return <Link href={href} aria-current={active ? "page" : undefined} {...rest} />;
}
