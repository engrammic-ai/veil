/**
 * Pattern analysis for learning triggers from hydration events.
 * Analyzes which user messages led to hydration of tagged context items,
 * and generates regex-based triggers for high-confidence patterns.
 */

import type { ContextCache, HydrationEvent } from "./cache.ts";
import type { Trigger } from "./types.ts";

export interface LearnedPattern {
  pattern: string;      // Regex pattern string
  tags: string[];       // Tags to query
  confidence: number;   // 0-1 based on hit rate
  sampleSize: number;   // Number of events analyzed
}

/**
 * Analyze hydration events to find keyword -> tag patterns.
 *
 * Algorithm:
 * 1. Group hydrations by item tags
 * 2. Extract common words from user messages
 * 3. Score by frequency and uniqueness
 * 4. Generate regex patterns for high-confidence matches
 */
export function analyzePatterns(
  events: HydrationEvent[],
  cache: ContextCache,
  existingTriggers: Trigger[],
  minConfidence: number = 0.7,
  minSamples: number = 3,
): LearnedPattern[] {
  // Group by item tags
  const tagGroups = new Map<string, string[]>(); // tag -> user messages

  for (const event of events) {
    const item = cache.get(event.itemId);
    if (!item) continue;

    for (const tag of item.tags) {
      if (!tagGroups.has(tag)) tagGroups.set(tag, []);
      tagGroups.get(tag)!.push(event.userMessage);
    }
  }

  const patterns: LearnedPattern[] = [];

  for (const [tag, messages] of tagGroups) {
    if (messages.length < minSamples) continue;

    // Skip tags already covered by existing triggers
    if (existingTriggers.some(t => t.action.tags?.includes(tag))) continue;

    // Extract common words (simple approach)
    const wordCounts = countWords(messages);
    const topWords = getTopWords(wordCounts, 3);

    if (topWords.length === 0) continue;

    // Validate regex before storing
    const patternStr = topWords.map(w => `\\b${escapeRegex(w)}\\b`).join('|');
    try {
      new RegExp(patternStr, 'i');
    } catch {
      continue; // Skip invalid patterns
    }

    // Calculate confidence: how often do these words appear together?
    const regex = new RegExp(patternStr, 'i');
    const matches = messages.filter(m => regex.test(m)).length;
    const confidence = matches / messages.length;

    if (confidence >= minConfidence) {
      patterns.push({
        pattern: patternStr,
        tags: [tag],
        confidence,
        sampleSize: messages.length,
      });
    }
  }

  return patterns;
}

function countWords(messages: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    const words = msg.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length < 3) continue; // Skip short words
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

function getTopWords(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function patternToTrigger(
  pattern: LearnedPattern,
  existingIds: Set<string>,
): Trigger {
  // Generate unique ID
  let id = `learned_${pattern.tags.join('_')}`;
  let suffix = 0;
  while (existingIds.has(id)) {
    id = `learned_${pattern.tags.join('_')}_${++suffix}`;
  }

  return {
    id,
    pattern: new RegExp(pattern.pattern, 'i'),
    type: "keyword",
    action: { tags: pattern.tags },
    priority: 5, // Lower than defaults (10)
    enabled: true,
    learned: true,
    confidence: pattern.confidence,
  };
}
