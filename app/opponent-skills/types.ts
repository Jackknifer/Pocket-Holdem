export type OpponentSkill = {
  id: string;
  title: string;
  archetype: string;
  summary: string;
  objective: string;
  identity: string[];
  preflop: string[];
  postflop: {
    flop: string[];
    turn: string[];
    river: string[];
  };
  sizing: string[];
  adaptations: string[];
  stackAndTable: string[];
  decisionProtocol: string[];
  outputRequirements: string[];
  guardrails: string[];
};
