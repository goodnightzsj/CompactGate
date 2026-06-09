import type { ProfileHealth } from "./primary-failover-health.js";
import type {
  PrimaryCandidate,
  PrimaryRouteRequestContext
} from "./primary-failover-types.js";

const TOP_K_SCORE_WINDOW = 100;

interface ScoredCandidate {
  candidate: PrimaryCandidate;
  score: number;
}

export interface PrimaryCandidateSelectionInput {
  candidates: PrimaryCandidate[];
  context: Required<PrimaryRouteRequestContext>;
  now: number;
  random: () => number;
  healthForProfile: (profileId: string) => ProfileHealth;
  blockedUntil: (candidate: PrimaryCandidate, context: Required<PrimaryRouteRequestContext>, now: number) => number;
  stickyProfileId: (
    isUsable: (profileId: string) => boolean
  ) => string | null;
}

export function selectPrimaryCandidate(input: PrimaryCandidateSelectionInput): PrimaryCandidate {
  const selected =
    selectStickyCandidate(input) ??
    selectScoredCandidate(input);
  return selected;
}

function selectStickyCandidate(input: PrimaryCandidateSelectionInput): PrimaryCandidate | null {
  const profileId = input.stickyProfileId(
    (candidateProfileId) => usableCandidateById(input, candidateProfileId) !== null
  );
  return profileId
    ? usableCandidateById(input, profileId)
    : null;
}

function selectScoredCandidate(input: PrimaryCandidateSelectionInput): PrimaryCandidate {
  const eligible = input.candidates.filter((candidate) => isCandidateEligible(input, candidate));
  const pool = eligible.length > 0
    ? eligible
    : [...input.candidates].sort((left, right) => {
        const leftUntil = input.blockedUntil(left, input.context, input.now);
        const rightUntil = input.blockedUntil(right, input.context, input.now);
        return leftUntil === rightUntil ? left.order - right.order : leftUntil - rightUntil;
      });
  const scored = pool
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(input, candidate)
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.candidate.order - right.candidate.order;
    });
  const best = scored[0];
  if (!best) {
    return input.candidates[0];
  }

  const topK = scored
    .filter((candidate) => best.score - candidate.score <= TOP_K_SCORE_WINDOW)
    .slice(0, 3);
  if (topK.length <= 1) {
    return best.candidate;
  }

  return weightedChoice(topK, input.random);
}

function scoreCandidate(
  input: PrimaryCandidateSelectionInput,
  candidate: PrimaryCandidate
): number {
  const health = input.healthForProfile(candidate.id);
  const total = health.successes + health.failures;
  const errorRate = total > 0 ? health.failures / total : 0;
  const latencyPenalty = health.lastFirstTokenMs === null
    ? 0
    : Math.min(200, Math.round(health.lastFirstTokenMs / 100));

  return (
    10_000 -
    candidate.order * 500 -
    health.inFlight * 80 -
    health.transientFailures * 40 -
    Math.round(errorRate * 250) -
    latencyPenalty +
    (candidate.active ? 1_000 : 0)
  );
}

function weightedChoice(
  candidates: ScoredCandidate[],
  random: () => number
): PrimaryCandidate {
  const minScore = Math.min(...candidates.map((candidate) => candidate.score));
  const weights = candidates.map((candidate) => Math.max(1, candidate.score - minScore + 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) {
      return candidates[index].candidate;
    }
  }

  return candidates[0].candidate;
}

function usableCandidateById(
  input: PrimaryCandidateSelectionInput,
  profileId: string
): PrimaryCandidate | null {
  const candidate = input.candidates.find((item) => item.id === profileId);
  if (!candidate || !isCandidateEligible(input, candidate)) {
    return null;
  }

  return candidate;
}

function isCandidateEligible(
  input: PrimaryCandidateSelectionInput,
  candidate: PrimaryCandidate
): boolean {
  return input.blockedUntil(candidate, input.context, input.now) <= input.now;
}
