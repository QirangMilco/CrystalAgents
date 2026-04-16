import type { LanguageCode } from '../i18n/registry.ts';

/**
 * Session title generation utilities.
 *
 * Shared helpers for building title prompts and validating results.
 * Actual title generation is handled by agent classes using their respective SDKs:
 * - ClaudeAgent: Uses Claude SDK query()
 * - CodexAgent: Uses OpenAI SDK
 */

/** Slice text at the last word boundary within `max` characters. */
export function sliceAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const lastSpace = text.lastIndexOf(' ', max);
  return lastSpace > 0 ? text.slice(0, lastSpace) : text.slice(0, max);
}

/**
 * Check if text before a colon looks like LLM preamble.
 * Matches: "Title", "Topic", "Sure", "Sure, the title is", "Here's the topic", etc.
 */
function isPreamblePrefix(text: string): boolean {
  const lower = text.trim().toLowerCase();
  // Exact single-word preamble
  if (/^(?:title|topic|sure|okay|ok)$/.test(lower)) return true;
  // Starts with a known opener and optionally references title/topic
  if (/^(?:sure|okay|ok|here(?:'s| is))\b/.test(lower)) return true;
  // "the title/topic is" or similar
  if (/^the\s+(?:title|topic)\b/.test(lower)) return true;
  return false;
}

/**
 * Sanitize a language preference string before prompt interpolation.
 * Returns undefined for invalid/suspicious inputs so the caller falls back to auto-detect.
 */
export function sanitizeLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  const trimmed = language.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > 40) return undefined;
  // Allow letters (any script), Unicode marks, spaces, hyphens
  if (!/^[\p{L}\p{M}\s\-]+$/u.test(trimmed)) return undefined;
  return trimmed;
}

export interface TitlePromptOptions {
  language?: string;
  locale?: LanguageCode | string;
}

interface TitlePromptLocale {
  generateQuestion: string;
  generateStyle: string;
  regenerateQuestion: string;
  regenerateStyle: string;
  ignoreLowSignal: string;
  examples: string;
  userLabelSingle: string;
  userLabelPair: string;
  userLabelMultiple: string;
  latestAssistantLabel: string;
  topicLabel: string;
  replyIn: (language: string) => string;
  replyAutoDetect: string;
}

const TITLE_PROMPT_LOCALES: Record<LanguageCode, TitlePromptLocale> = {
  en: {
    generateQuestion: 'What topic or area is the user exploring? Reply with ONLY a short descriptive title (2-5 words).',
    generateStyle: 'Use a short descriptive label. Use plain text only - no markdown.',
    regenerateQuestion: 'Based on these messages, what is this conversation about?',
    regenerateStyle: 'Reply with ONLY a short descriptive title (2-5 words). Use plain text only - no markdown.',
    ignoreLowSignal: 'Ignore short acknowledgement messages (like "ok", "thanks", "do it") that do not carry topic information.',
    examples: 'Examples: "Auto Title Generation", "Dark Mode Support", "Fix API Authentication", "Database Schema Design", "React Performance"',
    userLabelSingle: 'User message:',
    userLabelPair: 'User messages (first, last):',
    userLabelMultiple: 'Selected user messages:',
    latestAssistantLabel: 'Latest assistant response:',
    topicLabel: 'Topic:',
    replyIn: (language: string) => `Reply in ${language}.`,
    replyAutoDetect: 'Reply in the same language as the user\'s messages.',
  },
  es: {
    generateQuestion: '¿Qué tema o área está explorando el usuario? Responde SOLO con un título breve y descriptivo (2-5 palabras).',
    generateStyle: 'Usa una etiqueta breve y descriptiva. Solo texto plano, sin markdown.',
    regenerateQuestion: 'Según estos mensajes, ¿de qué trata esta conversación?',
    regenerateStyle: 'Responde SOLO con un título breve y descriptivo (2-5 palabras). Solo texto plano, sin markdown.',
    ignoreLowSignal: 'Ignora mensajes breves de confirmación (como "ok", "gracias", "hazlo") que no aportan información del tema.',
    examples: 'Ejemplos: "Generación automática de títulos", "Soporte de modo oscuro", "Corregir autenticación de API", "Diseño de esquema de base de datos", "Rendimiento en React"',
    userLabelSingle: 'Mensaje del usuario:',
    userLabelPair: 'Mensajes del usuario (primero, último):',
    userLabelMultiple: 'Mensajes de usuario seleccionados:',
    latestAssistantLabel: 'Última respuesta del asistente:',
    topicLabel: 'Tema:',
    replyIn: (language: string) => `Responde en ${language}.`,
    replyAutoDetect: 'Responde en el mismo idioma que los mensajes del usuario.',
  },
  'zh-Hans': {
    generateQuestion: '用户正在探索什么主题或方向？只返回一个简短、准确的描述性标题（通常 4-12 个字）。',
    generateStyle: '使用简短描述性短语。仅使用纯文本，不要使用 Markdown。',
    regenerateQuestion: '根据这些消息，这段对话的主题是什么？',
    regenerateStyle: '只返回一个简短、准确的描述性标题（通常 4-12 个字）。仅使用纯文本，不要使用 Markdown。',
    ignoreLowSignal: '忽略不承载主题信息的简短确认消息（如“ok”“谢谢”“执行”）。',
    examples: '示例：“自动生成标题”“深色模式支持”“修复 API 认证”“数据库架构设计”“React 性能优化”',
    userLabelSingle: '用户消息：',
    userLabelPair: '用户消息（首条、末条）：',
    userLabelMultiple: '选取的用户消息：',
    latestAssistantLabel: '最新助手回复：',
    topicLabel: '主题：',
    replyIn: (language: string) => `请使用${language}回复。`,
    replyAutoDetect: '请使用与用户消息相同的语言回复。',
  },
  ja: {
    generateQuestion: 'ユーザーが探っているテーマや領域は何ですか。短く説明的なタイトルのみを返してください（通常 4〜12 文字程度）。',
    generateStyle: '短い説明ラベルを使用してください。プレーンテキストのみを使用し、Markdown は使わないでください。',
    regenerateQuestion: 'これらのメッセージに基づいて、この会話のテーマは何ですか。',
    regenerateStyle: '短く説明的なタイトルのみを返してください（通常 4〜12 文字程度）。プレーンテキストのみを使用し、Markdown は使わないでください。',
    ignoreLowSignal: 'トピック情報を含まない短い相づち（「ok」「ありがとう」「実行して」など）は無視してください。',
    examples: '例: 「自動タイトル生成」「ダークモード対応」「API 認証修正」「データベース設計」「React 性能改善」',
    userLabelSingle: 'ユーザーメッセージ:',
    userLabelPair: 'ユーザーメッセージ（最初・最後）:',
    userLabelMultiple: '選択したユーザーメッセージ:',
    latestAssistantLabel: '最新のアシスタント応答:',
    topicLabel: 'トピック:',
    replyIn: (language: string) => `${language}で回答してください。`,
    replyAutoDetect: 'ユーザーのメッセージと同じ言語で回答してください。',
  },
  hu: {
    generateQuestion: 'Milyen témát vagy területet vizsgál a felhasználó? CSAK egy rövid, leíró címet adj (2-5 szó).',
    generateStyle: 'Használj rövid, leíró címkét. Csak sima szöveg legyen, markdown nélkül.',
    regenerateQuestion: 'Ezek alapján az üzenetek alapján miről szól ez a beszélgetés?',
    regenerateStyle: 'CSAK egy rövid, leíró címet adj (2-5 szó). Csak sima szöveg legyen, markdown nélkül.',
    ignoreLowSignal: 'Hagyd figyelmen kívül a rövid visszajelző üzeneteket (például „ok”, „köszi”, „csináld”), ha nem hordoznak témainformációt.',
    examples: 'Példák: „Automatikus címgenerálás”, „Sötét mód támogatás”, „API-hitelesítés javítása”, „Adatbázis séma tervezés”, „React teljesítmény”',
    userLabelSingle: 'Felhasználói üzenet:',
    userLabelPair: 'Felhasználói üzenetek (első, utolsó):',
    userLabelMultiple: 'Kiválasztott felhasználói üzenetek:',
    latestAssistantLabel: 'Legutóbbi asszisztens válasz:',
    topicLabel: 'Téma:',
    replyIn: (language: string) => `Válaszolj ${language} nyelven.`,
    replyAutoDetect: 'A felhasználói üzenetek nyelvén válaszolj.',
  },
  de: {
    generateQuestion: 'Welches Thema oder Gebiet erkundet der Nutzer? Antworte NUR mit einem kurzen, beschreibenden Titel (2-5 Wörter).',
    generateStyle: 'Verwende eine kurze, beschreibende Bezeichnung. Nur Klartext, kein Markdown.',
    regenerateQuestion: 'Worum geht es in dieser Unterhaltung basierend auf diesen Nachrichten?',
    regenerateStyle: 'Antworte NUR mit einem kurzen, beschreibenden Titel (2-5 Wörter). Nur Klartext, kein Markdown.',
    ignoreLowSignal: 'Ignoriere kurze Bestätigungsnachrichten (wie „ok“, „danke“, „mach es“), die keine Themeninformation enthalten.',
    examples: 'Beispiele: „Automatische Titelgenerierung“, „Dark-Mode-Unterstützung“, „API-Authentifizierung korrigieren“, „Datenbankschema-Design“, „React-Performance“',
    userLabelSingle: 'Nutzernachricht:',
    userLabelPair: 'Nutzernachrichten (erste, letzte):',
    userLabelMultiple: 'Ausgewählte Nutzernachrichten:',
    latestAssistantLabel: 'Neueste Assistentenantwort:',
    topicLabel: 'Thema:',
    replyIn: (language: string) => `Antworte auf ${language}.`,
    replyAutoDetect: 'Antworte in derselben Sprache wie die Nutzernachrichten.',
  },
  pl: {
    generateQuestion: 'Jaki temat lub obszar eksploruje użytkownik? Odpowiedz WYŁĄCZNIE krótkim, opisowym tytułem (2-5 słów).',
    generateStyle: 'Użyj krótkiej, opisowej etykiety. Tylko zwykły tekst, bez markdown.',
    regenerateQuestion: 'Na podstawie tych wiadomości, o czym jest ta rozmowa?',
    regenerateStyle: 'Odpowiedz WYŁĄCZNIE krótkim, opisowym tytułem (2-5 słów). Tylko zwykły tekst, bez markdown.',
    ignoreLowSignal: 'Ignoruj krótkie wiadomości potwierdzające (np. „ok”, „dzięki”, „zrób to”), które nie niosą informacji o temacie.',
    examples: 'Przykłady: „Automatyczne generowanie tytułów”, „Obsługa trybu ciemnego”, „Naprawa uwierzytelniania API”, „Projekt schematu bazy danych”, „Wydajność Reacta”',
    userLabelSingle: 'Wiadomość użytkownika:',
    userLabelPair: 'Wiadomości użytkownika (pierwsza, ostatnia):',
    userLabelMultiple: 'Wybrane wiadomości użytkownika:',
    latestAssistantLabel: 'Najnowsza odpowiedź asystenta:',
    topicLabel: 'Temat:',
    replyIn: (language: string) => `Odpowiedz w języku: ${language}.`,
    replyAutoDetect: 'Odpowiedz w tym samym języku co wiadomości użytkownika.',
  },
};

function resolvePromptLocale(locale?: LanguageCode | string): TitlePromptLocale {
  if (!locale) return TITLE_PROMPT_LOCALES.en;
  if (locale in TITLE_PROMPT_LOCALES) {
    return TITLE_PROMPT_LOCALES[locale as LanguageCode];
  }
  return TITLE_PROMPT_LOCALES.en;
}

/**
 * Build a language instruction for title prompts.
 * Explicit preference takes priority; otherwise auto-detect from message content.
 */
function buildLanguageInstruction(promptLocale: TitlePromptLocale, language?: string): string {
  const safe = sanitizeLanguage(language);
  if (safe) {
    return promptLocale.replyIn(safe);
  }
  return promptLocale.replyAutoDetect;
}

/**
 * Build a prompt for generating a session title from a user message.
 *
 * @param message - The user's message to generate a title from
 * @param options.language - Preferred output language for the title
 * @param options.locale - Prompt locale for instruction text
 * @returns Formatted prompt string
 */
export function buildTitlePrompt(message: string, options?: TitlePromptOptions): string {
  const promptLocale = resolvePromptLocale(options?.locale);
  const snippet = sliceAtWord(message, 500);
  return [
    promptLocale.generateQuestion,
    promptLocale.generateStyle,
    buildLanguageInstruction(promptLocale, options?.language),
    promptLocale.examples,
    '',
    `${promptLocale.userLabelSingle} ${snippet}`,
    '',
    promptLocale.topicLabel,
  ].join('\n');
}

/** Max characters for a message to be considered potentially low-signal. */
const LOW_SIGNAL_MAX_CHARS = 12;
/** Max words for a message to be considered potentially low-signal. */
const LOW_SIGNAL_MAX_WORDS = 2;

/**
 * Check if a message is likely low-signal (short acknowledgement/command).
 * Language-agnostic: uses length + word count only.
 */
export function isLowSignal(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length > LOW_SIGNAL_MAX_CHARS) return false;
  if (trimmed.split(/\s+/).length > LOW_SIGNAL_MAX_WORDS) return false;
  // If it contains a question mark, it's probably a real question
  if (trimmed.includes('?')) return false;
  return true;
}

/**
 * Select a spread of user messages that captures the session's purpose:
 * first (original intent), a recent-biased middle, and last (current state).
 *
 * Strips trailing low-signal messages (short acknowledgements like "ok", "thanks")
 * before selecting, so the spread focuses on substantive content.
 * Falls back to unfiltered if all messages are low-signal.
 *
 * For 4+ messages, picks at indices 0, ~66%, and last — biasing toward
 * where the conversation ended up rather than the exact midpoint.
 */
export function selectSpreadMessages(allUserMessages: string[]): string[] {
  const count = allUserMessages.length;
  if (count === 0) return [];

  // Strip trailing low-signal messages
  let filtered = allUserMessages;
  let trimEnd = allUserMessages.length;
  while (trimEnd > 0 && isLowSignal(allUserMessages[trimEnd - 1]!)) {
    trimEnd--;
  }
  if (trimEnd > 0) {
    filtered = allUserMessages.slice(0, trimEnd);
  }
  // else: all messages are low-signal, keep original array

  const n = filtered.length;
  if (n === 1) return [filtered[0]!];
  if (n === 2) return [filtered[0]!, filtered[1]!];
  if (n === 3) return [filtered[0]!, filtered[1]!, filtered[2]!];

  const midIndex = Math.floor(n * 2 / 3);
  return [filtered[0]!, filtered[midIndex]!, filtered[n - 1]!];
}

/** Build a label for the user messages section based on how many were selected. */
function messagesSectionLabel(count: number, promptLocale: TitlePromptLocale): string {
  if (count === 1) return promptLocale.userLabelSingle;
  if (count === 2) return promptLocale.userLabelPair;
  return promptLocale.userLabelMultiple;
}

/**
 * Build a prompt for regenerating a session title from recent messages.
 *
 * @param recentUserMessages - Spread of user messages (first, middle, last)
 * @param lastAssistantResponse - The most recent assistant response
 * @param options.language - Preferred language for the title
 * @returns Formatted prompt string
 */
export function buildRegenerateTitlePrompt(
  recentUserMessages: string[],
  lastAssistantResponse: string,
  options?: TitlePromptOptions,
): string {
  const promptLocale = resolvePromptLocale(options?.locale);
  const userContext = recentUserMessages
    .map((msg) => sliceAtWord(msg, 500))
    .join('\n\n');
  const assistantSnippet = sliceAtWord(lastAssistantResponse, 500);

  const lines: string[] = [
    promptLocale.regenerateQuestion,
    promptLocale.regenerateStyle,
    promptLocale.ignoreLowSignal,
    buildLanguageInstruction(promptLocale, options?.language),
    promptLocale.examples,
  ];

  lines.push(
    '',
    messagesSectionLabel(recentUserMessages.length, promptLocale),
    userContext,
    '',
    promptLocale.latestAssistantLabel,
    assistantSnippet,
    '',
    promptLocale.topicLabel,
  );

  return lines.join('\n');
}

/** Max word count for non-CJK title validation. */
const MAX_TITLE_WORDS = 10;
/** Max character count for CJK title validation. */
const MAX_CJK_TITLE_CHARS = 24;

function isCjkLocale(locale?: string): boolean {
  if (!locale) return false;
  return locale.startsWith('zh') || locale.startsWith('ja') || locale.startsWith('ko');
}

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[。．.!！?？、，,：:;；\s]+$/u, '').trim();
}

function stripLocalizedPreamble(text: string): string {
  return text
    // Chinese
    .replace(/^(?:标题|主题|话题|建议标题|推荐标题|可用标题|本次标题)\s*[：:]\s*/u, '')
    .replace(/^(?:这(?:段)?对话(?:主要)?(?:是)?(?:关于|围绕)|主题(?:是|为)|标题(?:是|为)|可以命名为|建议命名为)\s*/u, '')
    // Japanese
    .replace(/^(?:タイトル|件名|トピック)\s*[：:]\s*/u, '')
    .replace(/^(?:この会話(?:のテーマ)?は|テーマは|タイトルは)\s*/u, '')
    .trim();
}

/**
 * Validate and clean a generated title.
 *
 * Iteratively strips known preamble artifacts, then removes markdown/quotes,
 * and applies locale-aware bounds.
 *
 * @param title - The raw title from the model
 * @param options.locale - Locale used to choose validation strategy
 * @returns Cleaned title, or null if invalid
 */
export function validateTitle(title: string | null | undefined, options?: { locale?: string }): string | null {
  if (!title) return null;

  let cleaned = title.trim();

  // Iterative preamble stripping: handles chained preambles like "Sure: Title: Foo"
  let prev = '';
  while (cleaned !== prev) {
    prev = cleaned;
    const colonIndex = cleaned.indexOf(':');
    if (colonIndex > 0 && colonIndex < 40) {
      const beforeColon = cleaned.slice(0, colonIndex);
      if (isPreamblePrefix(beforeColon)) {
        cleaned = cleaned.slice(colonIndex + 1).trim();
      }
    }
  }

  cleaned = stripLocalizedPreamble(cleaned);

  // Strip surrounding quotes
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }

  // Strip surrounding bold markers **title**
  if (cleaned.startsWith('**') && cleaned.endsWith('**')) {
    cleaned = cleaned.slice(2, -2);
  }

  // Strip leading markdown heading markers (one or more #, -, *)
  cleaned = cleaned.replace(/^[#\-*]+\s+/, '');

  // Use first non-empty line only
  cleaned = cleaned.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';

  const cjkMode = isCjkLocale(options?.locale);

  // In CJK mode, if the model returned a sentence, keep the first clause.
  if (cjkMode) {
    const clause = cleaned.split(/[。！？!?]/u)[0];
    if (clause) cleaned = clause.trim();
  }

  cleaned = trimTrailingPunctuation(cleaned);

  // Reject obvious sentence-like outputs even if they are short enough.
  if (/^(?:我(?:想|要|希望)|请帮我|帮我|I want to|Help me|Please help me)\b/iu.test(cleaned)) return null;
  if (/[，,。.!！?？；;]/u.test(cleaned)) return null;

  // Reject empty or suspiciously long raw output
  if (cleaned.length === 0 || cleaned.length >= 100) return null;

  if (cjkMode) {
    // CJK titles are length-based rather than whitespace word-based.
    if (cleaned.length > MAX_CJK_TITLE_CHARS) {
      cleaned = trimTrailingPunctuation(cleaned.slice(0, MAX_CJK_TITLE_CHARS));
    }
    return cleaned.length > 0 ? cleaned : null;
  }

  // Non-CJK: keep existing word-count guard against verbose responses.
  if (cleaned.split(/\s+/).length > MAX_TITLE_WORDS) return null;

  return cleaned;
}
