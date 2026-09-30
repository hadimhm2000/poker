"use server";

import { avatarInput, mergePlayers, paymentInfoInput, removeMember, revokeInvite, setAvatar, setPaymentInfo } from "@poker/db";
import { getLocale } from "next-intl/server";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { sealPayment } from "@/lib/payment";
import { errorCode, withUser } from "@/lib/session";

// Home members, invite links and player profiles (avatar, payment details, merging).

const uuid = z.string().uuid();

async function go(path: string, error?: string): Promise<never> {
  const locale = await getLocale();
  const sep = path.includes("?") ? "&" : "?";
  return redirect({ href: error ? `${path}${sep}error=${error}` : path, locale });
}

async function attempt<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof z.ZodError) return go(path, "INVALID");
    unstable_rethrow(e);
    return go(path, errorCode(e));
  }
}

/** Host: remove a member. RLS refuses anyone else, and never removes the host's own row. */
export async function removeMemberAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const userId = uuid.parse(form.get("userId"));
  await attempt(`/homes/${homeId}`, () => withUser((tx) => removeMember(tx, homeId, userId)));
  return go(`/homes/${homeId}#members`);
}

export async function revokeInviteAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const inviteId = uuid.parse(form.get("inviteId"));
  await attempt(`/homes/${homeId}`, () => withUser((tx) => revokeInvite(tx, homeId, inviteId)));
  return go(`/homes/${homeId}#invites`);
}

/** Avatar and payment details of one player: the host, or the player's own linked user. */
export async function playerProfileAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  const playerId = uuid.parse(form.get("playerId"));
  await attempt(`/homes/${homeId}`, async () => {
    const avatar = avatarInput.parse(String(form.get("avatar") ?? "") || null);
    const payment = paymentInfoInput.parse(String(form.get("paymentInfo") ?? ""));
    // Encrypted here, before it reaches the database; the key never leaves the server.
    const sealed = sealPayment(payment);
    await withUser(async (tx) => {
      await setAvatar(tx, playerId, avatar);
      await setPaymentInfo(tx, playerId, sealed);
    });
  });
  return go(`/homes/${homeId}#players`);
}

/** Host: merge a duplicate player into the one to keep. */
export async function mergePlayersAction(form: FormData) {
  const homeId = uuid.parse(form.get("homeId"));
  await attempt(`/homes/${homeId}`, () => {
    const keep = uuid.parse(form.get("keepId"));
    const duplicate = uuid.parse(form.get("duplicateId"));
    return withUser((tx) => mergePlayers(tx, keep, duplicate));
  });
  return go(`/homes/${homeId}#players`);
}
