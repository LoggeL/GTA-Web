import type { ContactId } from './types';

export type StoryContactId = Exclude<ContactId, 'garage' | 'all-contacts'>;
export type StoryEndingChoice = 'rule' | 'expose';

export interface StoryContactProfile {
  readonly id: StoryContactId;
  readonly name: string;
  readonly role: string;
}

export interface EndingRecapDefinition {
  readonly choice: StoryEndingChoice;
  readonly title: string;
  readonly summary: string;
}

/** Authored copy shared by the mission log and future presentation layers. */
export const STORY_CONTACTS: readonly StoryContactProfile[] = [
  { id: 'juno', name: 'Juno Vale', role: 'Driver and route broker' },
  { id: 'malik', name: 'Malik Ward', role: 'Club owner and account fixer' },
  { id: 'priya', name: 'Priya Nayar', role: 'Network engineer and investigator' },
] as const;

/** Non-spoiler-free recaps are exposed only after their branch is selected. */
export const ENDING_RECAPS: readonly EndingRecapDefinition[] = [
  {
    choice: 'rule',
    title: 'Rule the Network',
    summary: 'Alex seizes the creditor network, reroutes its money, and keeps its power under new management.',
  },
  {
    choice: 'expose',
    title: 'Expose the Network',
    summary: 'Alex broadcasts the ledger across Solara, breaking the creditor network into evidence no one can bury.',
  },
] as const;
