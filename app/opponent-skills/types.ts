export type OpponentSkill = {
  id: string;
  version: string;
  title: string;
  archetype: string;
  summary: string;
  objective: string;
  priorityOrder: string[];
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
  decisionMatrix: Array<{
    trigger: string;
    prefer: string;
    avoid: string;
    evidence: string;
  }>;
  decisionProtocol: string[];
  outputRequirements: string[];
  failureModes: string[];
  guardrails: string[];
};
