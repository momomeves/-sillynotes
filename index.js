// Развлекательное расширение: кнопка на "волшебной палочке", генерирующая
// слух, газетную заметку, розыскной плакат или объявление по текущему контексту чата.

import { extension_settings, getContext, renderExtensionTemplateAsync } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

// Папку могут установить под любым именем (например, SillyTavern называет её по
// имени репозитория при установке по GitHub-ссылке), поэтому вычисляем путь
// динамически вместо того, чтобы жёстко прописывать "town-crier".
const currentFolderPath = import.meta.url.substring(0, import.meta.url.lastIndexOf("/"));
const extensionTemplatePath = currentFolderPath.split("/scripts/extensions/")[1];
const extensionName = currentFolderPath.substring(currentFolderPath.lastIndexOf("/") + 1);

const defaultSettings = {
    includeContext: true,
    contextMessages: 10,
    customInstructions: "",
};

const GENRES = {
    rumor: {
        label: "Слух",
        icon: "fa-comments",
        cssClass: "tc-rumor",
        prompt: "Придумай короткий колоритный слух или сплетню (2-4 предложения), который мог бы ходить в таверне или на улицах этого мира. Пиши от третьего лица, в стиле устной молвы («Говорят, что...», «Болтают, будто...»). Без заголовков и пояснений — только сам текст слуха.",
    },
    newspaper: {
        label: "Газета",
        icon: "fa-newspaper",
        cssClass: "tc-newspaper",
        prompt: "Напиши короткую заметку в стиле газетной статьи: сначала ЗАГОЛОВОК ЗАГЛАВНЫМИ БУКВАМИ, затем 2-4 абзаца текста в характерном журналистском стиле, описывающих какое-нибудь событие в этом мире.",
    },
    wanted: {
        label: "Розыск",
        icon: "fa-user-secret",
        cssClass: "tc-wanted",
        prompt: "Составь текст плаката «РАЗЫСКИВАЕТСЯ»: имя или прозвище персонажа из этого мира, приметы, за что разыскивается, размер награды. Оформи как объявление о розыске.",
    },
    notice: {
        label: "Объявление",
        icon: "fa-scroll",
        cssClass: "tc-notice",
        prompt: "Напиши короткое объявление, которое могло бы висеть на доске в таверне или на городской площади этого мира: услуги, находки, приглашения, предупреждения и т.п.",
    },
};

function ensureSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }
    return extension_settings[extensionName];
}

function loadSettingsUi() {
    const settings = ensureSettings();
    $("#tc_include_context").prop("checked", settings.includeContext);
    $("#tc_custom_instructions").val(settings.customInstructions);
}

function onIncludeContextInput(event) {
    ensureSettings().includeContext = Boolean($(event.target).prop("checked"));
    saveSettingsDebounced();
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
    const systemPrompt = "Ты — генератор колоритного игрового контента для настольной ролевой игры. Отвечай только запрошенным текстом, без вступлений от себя и без markdown-разметки.";

    let prompt = `${buildContextSnippet()}${genre.prompt}`;
    if (topic) prompt += `\n\nТема/детали, которые нужно обыграть: ${topic}`;
    if (settings.customInstructions?.trim()) prompt += `\n\nДополнительные указания: ${settings.customInstructions.trim()}`;

    const result = await callLLM(systemPrompt, prompt);
    return (result || "").trim();
}

function escapeHtml(text) {
    return $("<div>").text(text).html();
}

async function onGenerateClick(genreKey) {
    const genre = GENRES[genreKey];
    const topic = $("#tc_topic_input").val()?.trim();
    const $area = $("#tc_generate_area");

    $area.html('<div class="tc-loading"><i class="fa-solid fa-spinner fa-spin"></i> Генерируется…</div>');

    try {
        const text = await generateContent(genreKey, topic);
        $area.html(`
            <div class="tc-result ${genre.cssClass}" title="Нажмите, чтобы скопировать">
                <div class="tc-result-header"><i class="fa-solid ${genre.icon}"></i> ${genre.label}</div>
                <div class="tc-result-body">${escapeHtml(text).replace(/\n/g, "<br>")}</div>
            </div>
        `);
        $area.data("lastText", text);
    } catch (error) {
        console.error("[Town Crier] generation failed", error);
        $area.html(`<div class="tc-error">Не удалось сгенерировать: ${escapeHtml(error?.message || String(error))}</div>`);
    }
}

function closePopup() {
    $("#tc_overlay").remove();
    $(document).off("keydown.tc");
}

function openPopup() {
    $("#tc_overlay").remove();

    const genreButtons = Object.entries(GENRES)
        .map(([key, g]) => `<div class="tc-genre-btn menu_button" data-genre="${key}"><i class="fa-solid ${g.icon}"></i> ${g.label}</div>`)
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
    $("#tc_custom_instructions").on("input", onCustomInstructionsInput);

    // Делегированные обработчики — вешаем один раз на document, попап можно
    // открывать/закрывать сколько угодно раз без повторного связывания.
    $(document).on("click", ".tc-genre-btn", function () {
        onGenerateClick($(this).data("genre"));
    });
    $(document).on("click", ".tc-result", function () {
        const text = $("#tc_generate_area").data("lastText");
        if (text) {
            navigator.clipboard.writeText(text);
            toastr.info("Скопировано в буфер обмена");
        }
    });

    const wandButtonHtml = `
        <div id="town_crier_wand_button" class="list-group-item flex-container flexGap5" title="Городской глашатай">
            <i class="fa-solid fa-scroll extensionsMenuExtensionButton"></i>
            <span>Городской глашатай</span>
        </div>
    `;
    $("#extensionsMenu").append(wandButtonHtml);
    $(document).on("click", "#town_crier_wand_button", openPopup);
});
