// Развлекательное расширение: кнопка на "волшебной палочке", генерирующая
// слух, газетную заметку, розыскной плакат или объявление по текущему контексту чата.

import { extension_settings, getContext, renderExtensionTemplateAsync } from "../../../extensions.js";
import { saveSettingsDebounced, extension_prompt_types, extension_prompt_roles } from "../../../../script.js";

// Папку могут установить под любым именем (например, SillyTavern называет её по
// имени репозитория при установке по GitHub-ссылке), поэтому вычисляем путь
// динамически вместо того, чтобы жёстко прописывать "town-crier".
const currentFolderPath = import.meta.url.substring(0, import.meta.url.lastIndexOf("/"));
const extensionTemplatePath = currentFolderPath.split("/scripts/extensions/")[1];
const extensionName = currentFolderPath.substring(currentFolderPath.lastIndexOf("/") + 1);

const EXTENSION_PROMPT_KEY = "town_crier_last_entry";
const EXTENSION_PROMPT_DEPTH = 4;
const HISTORY_LIMIT = 20;

const defaultSettings = {
    includeContext: true,
    contextMessages: 5,
    customInstructions: "",
    includeLastEntryInContext: false,
};

const GENRES = {
    rumor: {
        label: "Слух",
        icon: "fa-comments",
        color: "#cba135",
        cssClass: "tc-rumor",
        emojiHint: "🗣️ 🤫 👂",
        prompt: "Придумай короткий колоритный слух или сплетню (2-4 предложения), который мог бы ходить в таверне или на улицах этого мира. Пиши от третьего лица, в стиле устной молвы («Говорят, что...», «Болтают, будто...»).",
    },
    newspaper: {
        label: "Газета",
        icon: "fa-newspaper",
        color: "#3a6ea5",
        cssClass: "tc-newspaper",
        emojiHint: "📰 🖋️",
        prompt: "Напиши короткую заметку в стиле газетной статьи: сначала ЗАГОЛОВОК ЗАГЛАВНЫМИ БУКВАМИ, затем 2-4 абзаца текста в характерном журналистском стиле, описывающих какое-нибудь событие в этом мире.",
    },
    wanted: {
        label: "Розыск",
        icon: "fa-user-secret",
        color: "#b5432b",
        cssClass: "tc-wanted",
        emojiHint: "🎯 💰",
        prompt: "Составь текст плаката «РАЗЫСКИВАЕТСЯ»: имя или прозвище персонажа из этого мира, приметы, за что разыскивается, размер награды.",
    },
    notice: {
        label: "Объявление",
        icon: "fa-scroll",
        color: "#3f7d4f",
        cssClass: "tc-notice",
        emojiHint: "📌 🔔",
        prompt: "Напиши короткое объявление, которое могло бы висеть на доске в таверне или на городской площади этого мира: услуги, находки, приглашения, предупреждения и т.п.",
    },
};

let viewIndex = 0;

function ensureSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const settings = extension_settings[extensionName];

    if (settings.includeContext === undefined) settings.includeContext = defaultSettings.includeContext;
    if (settings.contextMessages === undefined) settings.contextMessages = defaultSettings.contextMessages;
    if (settings.customInstructions === undefined) settings.customInstructions = defaultSettings.customInstructions;
    if (settings.includeLastEntryInContext === undefined) settings.includeLastEntryInContext = defaultSettings.includeLastEntryInContext;
    if (!settings.historyByChat) settings.historyByChat = {};

    return settings;
}

function getChatKey() {
    const context = getContext();
    return String(context.groupId || context.chatId || "no-chat");
}

function getHistory() {
    const settings = ensureSettings();
    const key = getChatKey();
    if (!settings.historyByChat[key]) settings.historyByChat[key] = [];
    return settings.historyByChat[key];
}

function addEntryToHistory(entry) {
    const history = getHistory();
    history.unshift(entry);
    history.length = Math.min(history.length, HISTORY_LIMIT);
    saveSettingsDebounced();
}

function removeEntryFromHistory(entryId) {
    const settings = ensureSettings();
    const key = getChatKey();
    settings.historyByChat[key] = (settings.historyByChat[key] || []).filter((e) => e.id !== entryId);
    saveSettingsDebounced();
}

function clearHistory() {
    const settings = ensureSettings();
    settings.historyByChat[getChatKey()] = [];
    saveSettingsDebounced();
}

function loadSettingsUi() {
    const settings = ensureSettings();
    $("#tc_include_context").prop("checked", settings.includeContext);
    $("#tc_context_messages").val(settings.contextMessages);
    $("#tc_include_last_entry").prop("checked", settings.includeLastEntryInContext);
    $("#tc_custom_instructions").val(settings.customInstructions);
    updateContextMessagesDisabled();
}

function updateContextMessagesDisabled() {
    $("#tc_context_messages").prop("disabled", !$("#tc_include_context").prop("checked"));
}

function onIncludeContextInput(event) {
    ensureSettings().includeContext = Boolean($(event.target).prop("checked"));
    saveSettingsDebounced();
    updateContextMessagesDisabled();
}

function onContextMessagesInput(event) {
    let value = parseInt($(event.target).val(), 10);
    if (Number.isNaN(value)) value = defaultSettings.contextMessages;
    value = Math.min(50, Math.max(1, value));
    $(event.target).val(value);
    ensureSettings().contextMessages = value;
    saveSettingsDebounced();
}

function onIncludeLastEntryInput(event) {
    ensureSettings().includeLastEntryInContext = Boolean($(event.target).prop("checked"));
    saveSettingsDebounced();
    syncExtensionPrompt();
}

function onCustomInstructionsInput(event) {
    ensureSettings().customInstructions = $(event.target).val();
    saveSettingsDebounced();
}

function buildContextSnippet() {
    const settings = ensureSettings();
    if (!settings.includeContext) return "";

    const context = getContext();
    const chat = context.chat || [];
    const recent = chat
        .slice(-settings.contextMessages)
        .map((m) => `${m.name}: ${m.mes}`)
        .join("\n");

    return recent ? `Контекст текущей сцены (только для вдохновения, не пересказывай его напрямую):\n${recent}\n\n` : "";
}

async function callLLM(systemPrompt, prompt) {
    const context = getContext();
    if (typeof context.generateRaw === "function") {
        return await context.generateRaw({ systemPrompt, prompt });
    }
    // Фолбэк для старых версий клиента, где generateRaw ещё не было.
    return await context.generateQuietPrompt({ quietPrompt: `${systemPrompt}\n\n${prompt}` });
}

async function generateContent(genreKey, topic) {
    const genre = GENRES[genreKey];
    const settings = ensureSettings();
    const systemPrompt = "Ты — генератор колоритного игрового контента для настольной ролевой игры. Отвечай только запрошенным текстом на русском языке, без вступлений и пояснений от себя.";

    const styleInstruction = `Можно использовать 1-3 уместных эмодзи (например: ${genre.emojiHint}) и простой текстовый разделитель вроде «⸻» или «───» там, где это оживит текст, но не используй markdown-разметку (никаких **, #, [] и т.п.) и не пиши HTML-теги — только обычный текст.`;

    let prompt = `${buildContextSnippet()}${genre.prompt}\n\n${styleInstruction}`;
    if (topic) prompt += `\n\nТема/детали, которые нужно обыграть: ${topic}`;
    if (settings.customInstructions?.trim()) prompt += `\n\nДополнительные указания: ${settings.customInstructions.trim()}`;

    const result = await callLLM(systemPrompt, prompt);
    return (result || "").trim();
}

function escapeHtml(text) {
    return $("<div>").text(text).html();
}

// Вписывает последнюю запись глашатая в промпт основного чата как фоновую
// заметку (тем же механизмом, что использует Author's Note), либо снимает её,
// если тумблер выключен или записей больше нет.
function syncExtensionPrompt() {
    const context = getContext();
    if (typeof context.setExtensionPrompt !== "function") return;

    const settings = ensureSettings();
    const latest = settings.includeLastEntryInContext ? getHistory()[0] : null;

    if (!latest) {
        context.setExtensionPrompt(EXTENSION_PROMPT_KEY, "", extension_prompt_types.NONE, EXTENSION_PROMPT_DEPTH);
        return;
    }

    const genre = GENRES[latest.genre] || GENRES.notice;
    const text = `[Городская молва (необязательный фоновый штрих для атмосферы, ${genre.label.toLowerCase()}): ${latest.text}]`;

    context.setExtensionPrompt(
        EXTENSION_PROMPT_KEY,
        text,
        extension_prompt_types.IN_PROMPT,
        EXTENSION_PROMPT_DEPTH,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function renderEntryViewer() {
    const $area = $("#tc_generate_area");
    const history = getHistory();

    if (history.length === 0) {
        $area.html('<div class="tc-empty">История пуста — сгенерируйте первую запись выше.</div>');
        return;
    }

    viewIndex = Math.max(0, Math.min(viewIndex, history.length - 1));
    const entry = history[viewIndex];
    const genre = GENRES[entry.genre] || GENRES.notice;
    const dateLabel = new Date(entry.timestamp).toLocaleString();

    $area.html(`
        <div class="tc-entry-viewer">
            <div class="tc-pager">
                <button type="button" class="tc-pager-btn" data-dir="-1" title="Более свежая запись" ${viewIndex <= 0 ? "disabled" : ""}><i class="fa-solid fa-chevron-left"></i></button>
                <span class="tc-pager-count">${viewIndex + 1} из ${history.length}</span>
                <button type="button" class="tc-pager-btn" data-dir="1" title="Более старая запись" ${viewIndex >= history.length - 1 ? "disabled" : ""}><i class="fa-solid fa-chevron-right"></i></button>
                <span class="tc-pager-spacer"></span>
                <button type="button" id="tc_entry_delete" title="Удалить эту запись"><i class="fa-solid fa-trash"></i></button>
                <button type="button" id="tc_history_clear" title="Очистить всю историю"><i class="fa-solid fa-trash-can"></i></button>
            </div>
            <div class="tc-result ${genre.cssClass}" data-entry-id="${entry.id}" title="Нажмите, чтобы скопировать">
                <div class="tc-result-header" style="color:${genre.color}">
                    <i class="fa-solid ${genre.icon}"></i>
                    <span>${genre.label}</span>
                    <span class="tc-result-time">${escapeHtml(dateLabel)}</span>
                </div>
                <div class="tc-result-body">${escapeHtml(entry.text).replace(/\n/g, "<br>")}</div>
            </div>
        </div>
    `);
}

async function onGenerateClick(genreKey) {
    const topic = $("#tc_topic_input").val()?.trim();
    const $area = $("#tc_generate_area");

    $area.html('<div class="tc-loading"><i class="fa-solid fa-spinner fa-spin"></i> Генерируется…</div>');

    try {
        const text = await generateContent(genreKey, topic);
        addEntryToHistory({
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            genre: genreKey,
            topic: topic || "",
            text,
            timestamp: Date.now(),
        });
        viewIndex = 0;
        syncExtensionPrompt();
        renderEntryViewer();
    } catch (error) {
        console.error("[Town Crier] generation failed", error);
        $area.html(`<div class="tc-error">Не удалось сгенерировать: ${escapeHtml(error?.message || String(error))}</div>`);
    }
}

function onPagerClick(event) {
    viewIndex += parseInt($(event.currentTarget).data("dir"), 10);
    renderEntryViewer();
}

function onDeleteEntryClick() {
    const entry = getHistory()[viewIndex];
    if (!entry) return;
    removeEntryFromHistory(entry.id);
    syncExtensionPrompt();
    renderEntryViewer();
    toastr.info("Запись удалена");
}

function onClearHistoryClick() {
    if (!confirm("Удалить всю историю записей глашатая для этого чата? Действие необратимо.")) return;
    clearHistory();
    viewIndex = 0;
    syncExtensionPrompt();
    renderEntryViewer();
    toastr.info("История очищена");
}

function onCopyEntryClick(event) {
    const entryId = $(event.currentTarget).data("entryId");
    const entry = getHistory().find((e) => e.id === entryId);
    if (entry) {
        navigator.clipboard.writeText(entry.text);
        toastr.info("Скопировано в буфер обмена");
    }
}

function closePopup() {
    $("#tc_overlay").remove();
    $(document).off("keydown.tc");
}

function openPopup() {
    $("#tc_overlay").remove();
    viewIndex = 0;

    const genreButtons = Object.entries(GENRES)
        .map(([key, g]) => `<div class="tc-genre-btn menu_button" data-genre="${key}" style="--tc-color:${g.color}"><i class="fa-solid ${g.icon}"></i> ${g.label}</div>`)
        .join("");

    const html = `
        <div id="tc_overlay">
            <div id="tc_modal">
                <div id="tc_modal_header">
                    <span><i class="fa-solid fa-scroll"></i> Городской глашатай</span>
                    <i class="fa-solid fa-xmark tc_close" title="Закрыть"></i>
                </div>
                <div id="tc_modal_body">
                    <input id="tc_topic_input" class="text_pole" type="text" placeholder="Тема или детали (необязательно)" />
                    <div class="tc-genres">${genreButtons}</div>
                    <div id="tc_generate_area"></div>
                </div>
            </div>
        </div>
    `;

    $("body").append(html);
    renderEntryViewer();

    $("#tc_overlay").on("click", (event) => {
        if (event.target.id === "tc_overlay") closePopup();
    });
    $(".tc_close").on("click", closePopup);
    $(document)
        .off("keydown.tc")
        .on("keydown.tc", (event) => {
            if (event.key === "Escape") closePopup();
        });
}

function onChatChanged() {
    viewIndex = 0;
    syncExtensionPrompt();
    if ($("#tc_overlay").length) renderEntryViewer();
}

jQuery(async () => {
    ensureSettings();

    try {
        const settingsHtml = await renderExtensionTemplateAsync(extensionTemplatePath, "settings");
        $("#extensions_settings2").append(settingsHtml);
        loadSettingsUi();
    } catch (error) {
        // Панель настроек — не критична для основной функции (кнопки на палочке),
        // поэтому ошибку тут не даём остановить остальную инициализацию.
        console.error("[Town Crier] failed to load settings panel", error);
    }

    $("#tc_include_context").on("input", onIncludeContextInput);
    $("#tc_context_messages").on("input", onContextMessagesInput);
    $("#tc_include_last_entry").on("input", onIncludeLastEntryInput);
    $("#tc_custom_instructions").on("input", onCustomInstructionsInput);

    // Делегированные обработчики — вешаем один раз на document, попап можно
    // открывать/закрывать сколько угодно раз без повторного связывания.
    $(document).on("click", ".tc-genre-btn", function () {
        onGenerateClick($(this).data("genre"));
    });
    $(document).on("click", ".tc-pager-btn", onPagerClick);
    $(document).on("click", "#tc_entry_delete", onDeleteEntryClick);
    $(document).on("click", "#tc_history_clear", onClearHistoryClick);
    $(document).on("click", ".tc-result", onCopyEntryClick);

    const context = getContext();
    if (context.eventSource && context.event_types?.CHAT_CHANGED) {
        context.eventSource.on(context.event_types.CHAT_CHANGED, onChatChanged);
    }

    const wandButtonHtml = `
        <div id="town_crier_wand_button" class="list-group-item flex-container flexGap5" title="Городской глашатай">
            <i class="fa-solid fa-scroll extensionsMenuExtensionButton"></i>
            <span>Городской глашатай</span>
        </div>
    `;
    $("#extensionsMenu").append(wandButtonHtml);
    $(document).on("click", "#town_crier_wand_button", openPopup);

    // На случай, если тумблер "учитывать в чате" был включён ещё в прошлой сессии.
    syncExtensionPrompt();
});
