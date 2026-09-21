/**
 * @typedef {'answer_from_memory' | 'llm' | 'clarify' | 'review'} Route
 *
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} text
 * @property {number} distance  semantic distance (lower = closer)
 * @property {boolean} [gold_relevant]
 * @property {number} [gold_rank]
 *
 * @typedef {object} Case
 * @property {string} id
 * @property {'EN'|'VI'} lang
 * @property {string} category
 * @property {string} query
 * @property {Candidate[]} candidates
 * @property {boolean} gold_answerable
 * @property {Route} gold_route
 * @property {string|null} gold_top1_id
 * @property {string} [notes]
 *
 * @typedef {object} JevCandidateJudgment
 * @property {string} candidateId
 * @property {number} relevanceScore  0..N-1 weighted score from Score question
 * @property {number} answerableNoul  0..1
 * @property {number} [confidence]
 *
 * @typedef {object} JevDecision
 * @property {JevCandidateJudgment[]} judgments
 * @property {Route} routeChoice
 * @property {number} routeConfidence
 * @property {number} overallAnswerableNoul
 * @property {number} latencyMs
 * @property {number} inputTokens
 * @property {string} model
 * @property {boolean} usedMock
 * @property {boolean} fallback
 *
 * @typedef {object} ModeResult
 * @property {string} caseId
 * @property {string} mode
 * @property {string[]} rankedIds
 * @property {string|null} top1Id
 * @property {boolean} predictedAnswerable
 * @property {Route} predictedRoute
 * @property {number} latencyMs
 * @property {number} estCostUsd
 * @property {boolean} fallback
 * @property {boolean} usedMock
 */

export const ROUTES = /** @type {const} */ ([
  'answer_from_memory',
  'llm',
  'clarify',
  'review',
]);

/** Published TypeSafe price: $0.042 / million input tokens; output free. */
export const JEV_INPUT_USD_PER_MTOKEN = 0.042;

export const PINNED_JEV_MODEL = 'jev-1.13.0';
