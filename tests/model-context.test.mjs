import assert from "node:assert/strict";
import test from "node:test";
import { buildModelContext } from "../app/model-poker.ts";
import { newSession } from "../app/game.ts";

test("model context binds the actor to the complete opponent skill and public table frame", () => {
  const game = newSession(4);
  const actor = game.players.find((player) => player.id === "aria");
  assert.ok(actor);

  const context = buildModelContext(game, actor, 120, "aria");
  assert.equal(context.contextVersion, "2.0");
  assert.equal(context.role.skill.id, "aria");
  assert.equal(context.role.skill.version, "2.0");
  assert.equal(context.skillExecution.skillId, "aria");
  assert.equal(context.skillExecution.skillVersion, "2.0");
  assert.deepEqual(context.skillExecution.applyInOrder, [
    "guardrails", "decisionProtocol", "priorityOrder", "activeStreetRules", "decisionMatrix", "sizing", "outputRequirements",
  ]);
  assert.ok(context.skillExecution.activeStreetRules.length >= 3);
  assert.ok(context.skillExecution.decisionMatrix.length >= 5);
  assert.equal(context.actor.id, "aria");
  assert.match(context.actor.position, /BTN|SB|BB|UTG|HJ|CO|位置/);
  assert.equal(context.actionDeadlineSeconds, 120);
  assert.equal(context.gameRules.variant, "No-limit Texas Hold'em");
  assert.match(context.gameRules.board, /烧/);
  assert.match(context.informationBoundary.forbidden.join(" "), /hole cards|隐藏牌/);
});
