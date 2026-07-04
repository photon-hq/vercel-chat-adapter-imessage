import { ValidationError } from "@chat-adapter/shared";
import type { IMessageMessageEffect } from "spectrum-ts/providers/imessage";
import { imessage } from "spectrum-ts/providers/imessage";

export type { IMessageMessageEffect } from "spectrum-ts/providers/imessage";

/**
 * iMessage expressive-send effects, keyed by friendly name. Bubble effects
 * (`slam`, `loud`, `gentle`, `invisible`) animate the message bubble; the rest
 * are full-screen effects (`confetti`, `fireworks`, `balloons`, `heart`,
 * `lasers`, `celebration`, `sparkles`, `spotlight`, `echo`).
 *
 * Re-exported from spectrum-ts so callers can reference effects by name without
 * reaching into the provider package — e.g. `iMessageEffect.confetti`.
 */
export const iMessageEffect = imessage.effect.message;

/** Accepted effect names (`"confetti"`, `"fireworks"`, …). */
export type iMessageEffectName = keyof typeof iMessageEffect;

const EFFECT_IDS = new Set<string>(Object.values(iMessageEffect));
const EFFECT_NAMES = Object.keys(iMessageEffect);

/**
 * Resolve an effect argument to a spectrum-ts effect id. Accepts either a
 * friendly name (`"confetti"`) or the raw effect id
 * (`iMessageEffect.confetti`), so both styles work. Throws a `ValidationError`
 * on an unknown effect.
 */
export function resolveEffect(
  effect: IMessageMessageEffect | iMessageEffectName
): IMessageMessageEffect {
  if (effect in iMessageEffect) {
    return (iMessageEffect as Record<string, IMessageMessageEffect>)[effect];
  }
  if (EFFECT_IDS.has(effect)) {
    return effect as IMessageMessageEffect;
  }
  throw new ValidationError(
    "imessage",
    `Unknown iMessage effect: "${effect}". Supported: ${EFFECT_NAMES.join(", ")}`
  );
}
