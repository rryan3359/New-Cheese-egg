import type { StrategyResult } from "../market/types";

export type OpportunityGroup = {
  id: string;
  symbol: string;
  direction: "Long" | "Short";
  primary: StrategyResult;
  setups: StrategyResult[];
};

export type OpportunityConflict = {
  symbol: string;
  long: StrategyResult[];
  short: StrategyResult[];
};

function rank(setups: StrategyResult[]) {
  return [...setups].sort((a, b) =>
    Number(b.grade === "A") - Number(a.grade === "A") ||
    (b.primaryRiskReward ?? -1) - (a.primaryRiskReward ?? -1) ||
    b.confidence - a.confidence,
  );
}

export function groupOpportunitySetups(setups: StrategyResult[], minimumNetRr = 1.5) {
  const executable = setups.filter((setup) =>
    setup.status === "executable" && setup.direction !== "Neutral" &&
    setup.primaryRiskReward !== null && setup.primaryRiskReward >= Math.max(1.5, minimumNetRr),
  );
  const symbols = new Map<string, StrategyResult[]>();
  for (const setup of executable) symbols.set(setup.symbol, [...(symbols.get(setup.symbol) ?? []), setup]);
  const opportunities: OpportunityGroup[] = [];
  const conflicts: OpportunityConflict[] = [];
  for (const [symbol, rows] of symbols) {
    const long = rank(rows.filter((setup) => setup.direction === "Long"));
    const short = rank(rows.filter((setup) => setup.direction === "Short"));
    if (long.length && short.length) {
      conflicts.push({ symbol, long, short });
      continue;
    }
    const sameDirection = long.length ? long : short;
    if (!sameDirection.length) continue;
    const direction = sameDirection[0].direction as "Long" | "Short";
    opportunities.push({ id: `${symbol}-${direction}`, symbol, direction, primary: sameDirection[0], setups: sameDirection });
  }
  opportunities.sort((a, b) =>
    Number(b.primary.grade === "A") - Number(a.primary.grade === "A") ||
    b.setups.length - a.setups.length ||
    (b.primary.primaryRiskReward ?? -1) - (a.primary.primaryRiskReward ?? -1) ||
    b.primary.confidence - a.primary.confidence,
  );
  conflicts.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { opportunities, conflicts };
}
