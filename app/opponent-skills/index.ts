import { ariaSkill } from "./aria.ts";
import { irisSkill } from "./iris.ts";
import { knoxSkill } from "./knox.ts";
import { miraSkill } from "./mira.ts";
import { novaSkill } from "./nova.ts";
import { theoSkill } from "./theo.ts";
import type { OpponentSkill } from "./types.ts";

export type { OpponentSkill } from "./types";

export const OPPONENT_SKILLS: Record<string, OpponentSkill> = {
  iris: irisSkill,
  mira: miraSkill,
  knox: knoxSkill,
  aria: ariaSkill,
  theo: theoSkill,
  nova: novaSkill,
};
