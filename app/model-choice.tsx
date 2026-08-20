"use client";

export type ModelChoice = {
  id: string;
  name: string;
  model: string;
  /** Optional badge letter; defaults to the first character of the name. */
  mark?: string;
};

/**
 * The rows of the model chooser, shared by the lobby picker, the spectator seat picker and the
 * online AI seats so all three read the same. They must be rendered as direct children of a
 * `.lobby-model-popover`, which is what styles them.
 */
export function ModelChoiceOptions({ choices, value, onPick }: {
  choices: ModelChoice[];
  value: string;
  onPick: (id: string) => void;
}) {
  return (
    <>
      {choices.map((choice) => (
        <button
          type="button" role="option" key={choice.id || "default"} aria-selected={choice.id === value}
          className={choice.id === value ? "selected" : ""} onClick={() => onPick(choice.id)}
        >
          <span className="model-choice-mark">{choice.mark || choice.name.slice(0, 1)}</span>
          <span><b>{choice.name}</b><small>{choice.model}</small></span>
          <i>✓</i>
        </button>
      ))}
    </>
  );
}
