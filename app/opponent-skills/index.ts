import { ariaSkill } from "./aria";
import { knoxSkill } from "./knox";
import { miraSkill } from "./mira";
import { novaSkill } from "./nova";
import { theoSkill } from "./theo";
import type { OpponentSkill } from "./types";

export type { OpponentSkill } from "./types";

export const OPPONENT_SKILLS: Record<string, OpponentSkill> = {
  mira: miraSkill,
  knox: knoxSkill,
  aria: ariaSkill,
  theo: theoSkill,
  nova: novaSkill,
};
