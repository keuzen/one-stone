(function () {
  "use strict";

  const DB_NAME = "one-stone";
  const DB_VERSION = 1;
  const SETTINGS_STORE = "settings";
  const RECORDS_STORE = "records";
  const HABIT_KEY = "habit";
  const TERMS_CONSENT_KEY = "terms-consent";
  const TERMS_VERSION = "v3";
  const GA_MEASUREMENT_ID = "G-QW6L40SBLK";
  const SURVEY_ENDPOINT = "https://script.google.com/macros/s/AKfycbwi_CKjCa2iERQTk2m4r4NPgA0zW4FLQqDisv1IuqDpqbPC6t8vWj-H2ogVdyekHw6MJw/exec";
  const SURVEY_VERSION = "s2";
  const APP_VERSION = "a1";
  const SURVEY_STATE_KEY = "survey-state";
  const SURVEY_PROMPT_DELAY_MS = 2000;
  const SURVEY_COMMENT_MAX = 500;
  const SURVEY_POST_TIMEOUT_MS = 15000;
  const SURVEY_QUESTIONS = [
    { id: "q1", text: "今日のチェックで、「今日はできた」と自分を認められた", reachedOnly: true },
    { id: "q2", text: "設定から記録まで、迷わず進められた", reachedOnly: false },
    { id: "q3", text: "操作の負担は小さかった", reachedOnly: false },
    { id: "q4", text: "今日の習慣は、無理や不安なく行えた", reachedOnly: true }
  ];

  let database;
  let currentHabit;
  let todayKey = getDateKey(new Date());
  let termsEndReached = false;
  let analyticsLoadPromise;
  let analyticsEnabled = false;
  let surveyPromptTimer;
  let surveyPromptNo = 0;
  let survey = null;

  const elements = {};

  document.addEventListener("DOMContentLoaded", function () {
    elements.appMain = document.getElementById("app-main");
    elements.termsModal = document.getElementById("terms-modal");
    elements.termsScroll = document.getElementById("terms-scroll");
    elements.termsRead = document.getElementById("terms-read");
    elements.termsAgree = document.getElementById("terms-agree");
    elements.termsError = document.getElementById("terms-error");
    elements.setupSection = document.getElementById("setup-section");
    elements.setupForm = document.getElementById("setup-form");
    elements.tableSection = document.getElementById("table-section");
    elements.habitColumn = document.getElementById("habit-column");
    elements.recordsBody = document.getElementById("records-body");
    elements.emptyState = document.getElementById("empty-state");
    elements.recordTableContainer = document.getElementById("record-table-container");
    elements.tableStatus = document.getElementById("table-status");
    elements.todayRecord = document.getElementById("today-record");
    elements.error = document.getElementById("app-error");
    elements.surveyOpen = document.getElementById("survey-open");
    elements.surveyPrompt = document.getElementById("survey-prompt");
    elements.surveyPromptAnswer = document.getElementById("survey-prompt-answer");
    elements.surveyPromptLater = document.getElementById("survey-prompt-later");
    elements.surveyPromptDecline = document.getElementById("survey-prompt-decline");
    elements.surveyModal = document.getElementById("survey-modal");
    elements.surveyClose = document.getElementById("survey-close");
    elements.surveyForm = document.getElementById("survey-form");
    elements.surveyNotice = document.getElementById("survey-notice");
    elements.surveyProgress = document.getElementById("survey-progress");
    elements.surveyQuestionBlock = document.getElementById("survey-question-block");
    elements.surveyQuestionText = document.getElementById("survey-question-text");
    elements.surveyScale = document.getElementById("survey-scale");
    elements.surveyCommentBlock = document.getElementById("survey-comment-block");
    elements.surveyComment = document.getElementById("survey-comment");
    elements.surveyCommentCount = document.getElementById("survey-comment-count");
    elements.surveyWebsite = document.getElementById("survey-website");
    elements.surveyError = document.getElementById("survey-error");
    elements.surveyBack = document.getElementById("survey-back");
    elements.surveyNext = document.getElementById("survey-next");
    elements.surveySubmit = document.getElementById("survey-submit");
    elements.surveyDone = document.getElementById("survey-done");
    elements.surveyDoneClose = document.getElementById("survey-done-close");

    elements.setupForm.addEventListener("submit", handleHabitSubmit);
    elements.recordsBody.addEventListener("change", handleRecordChange);
    elements.todayRecord.addEventListener("click", handleTodayRecord);
    elements.termsScroll.addEventListener("scroll", handleTermsScroll);
    elements.termsRead.addEventListener("change", handleTermsReadChange);
    elements.termsAgree.addEventListener("click", handleTermsAgree);
    document.addEventListener("keydown", handleTermsKeydown);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    elements.surveyOpen.addEventListener("click", handleSurveyOpenClick);
    elements.surveyPromptAnswer.addEventListener("click", handleSurveyPromptAnswer);
    elements.surveyPromptLater.addEventListener("click", handleSurveyPromptLater);
    elements.surveyPromptDecline.addEventListener("click", handleSurveyPromptDecline);
    elements.surveyClose.addEventListener("click", closeSurvey);
    elements.surveyDoneClose.addEventListener("click", closeSurvey);
    elements.surveyScale.addEventListener("change", handleSurveyScaleChange);
    elements.surveyComment.addEventListener("input", handleSurveyCommentInput);
    elements.surveyBack.addEventListener("click", handleSurveyBack);
    elements.surveyNext.addEventListener("click", handleSurveyNext);
    elements.surveySubmit.addEventListener("click", submitSurvey);
    elements.surveyForm.addEventListener("submit", function (event) {
      event.preventDefault();
    });
    document.addEventListener("keydown", handleSurveyKeydown);

    initialise();
  });

  async function initialise() {
    try {
      database = await openDatabase();
      const termsConsent = await getTermsConsent();

      if (!termsConsent) {
        showTermsModal();
        return;
      }

      unlockApp();
      analyticsEnabled = true;
      startAnalytics();
      await loadAppState();
    } catch (error) {
      trackError("app_initialization");
      elements.appMain.hidden = false;
      elements.surveyOpen.hidden = true;
      showError("このブラウザに記録を保存できません。IndexedDBが利用できる環境で開いてください。");
      console.error(error);
    }
  }

  async function loadAppState() {
    currentHabit = await getHabit();
    const entryState = currentHabit ? "existing" : "new";
    trackEvent("one_stone_app_ready", { entry_state: entryState });

    if (currentHabit) {
      renderHabit(currentHabit);
      await refreshRecords();
    } else {
      showSetup();
    }

    refreshSurveyButton();
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB is not available."));
        return;
      }

      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function () {
        const upgradedDatabase = request.result;

        if (!upgradedDatabase.objectStoreNames.contains(SETTINGS_STORE)) {
          upgradedDatabase.createObjectStore(SETTINGS_STORE, { keyPath: "id" });
        }

        if (!upgradedDatabase.objectStoreNames.contains(RECORDS_STORE)) {
          upgradedDatabase.createObjectStore(RECORDS_STORE, { keyPath: "date" });
        }
      };

      request.onsuccess = function () {
        const openedDatabase = request.result;
        openedDatabase.onversionchange = function () {
          openedDatabase.close();
        };
        resolve(openedDatabase);
      };

      request.onerror = function () {
        reject(request.error || new Error("Could not open the database."));
      };
    });
  }

  function requestAsPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error("IndexedDB request failed."));
      };
    });
  }

  function getHabit() {
    const transaction = database.transaction(SETTINGS_STORE, "readonly");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).get(HABIT_KEY));
  }

  function getTermsConsent() {
    const transaction = database.transaction(SETTINGS_STORE, "readonly");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).get(TERMS_CONSENT_KEY)).then(function (consent) {
      if (!consent || consent.termsVersion !== TERMS_VERSION || consent.agreed !== true) {
        return null;
      }
      return consent;
    });
  }

  function saveHabit(habit) {
    const transaction = database.transaction(SETTINGS_STORE, "readwrite");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).put(habit));
  }

  function saveTermsConsent() {
    const transaction = database.transaction(SETTINGS_STORE, "readwrite");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).put({
      id: TERMS_CONSENT_KEY,
      agreed: true,
      termsVersion: TERMS_VERSION,
      agreedAt: new Date().toISOString()
    }));
  }

  function getRecords() {
    const transaction = database.transaction(RECORDS_STORE, "readonly");
    return requestAsPromise(transaction.objectStore(RECORDS_STORE).getAll());
  }

  function saveRecord(date, checked) {
    return new Promise(function (resolve, reject) {
      const transaction = database.transaction(RECORDS_STORE, "readwrite");
      const store = transaction.objectStore(RECORDS_STORE);
      const getRequest = store.get(date);

      getRequest.onsuccess = function () {
        const now = new Date().toISOString();
        const record = getRequest.result || {
          date: date,
          createdAt: now
        };

        record.checked = checked;
        record.checkedAt = checked ? now : null;
        record.updatedAt = now;

        const putRequest = store.put(record);
        putRequest.onsuccess = function () {
          resolve(record);
        };
        putRequest.onerror = function () {
          reject(putRequest.error || new Error("Could not save the record."));
        };
      };

      getRequest.onerror = function () {
        reject(getRequest.error || new Error("Could not read the record."));
      };
      transaction.onerror = function () {
        reject(transaction.error || new Error("Could not update the record."));
      };
      transaction.onabort = function () {
        reject(transaction.error || new Error("The record transaction was aborted."));
      };
    });
  }

  function createTodayRecord() {
    return new Promise(function (resolve, reject) {
      const transaction = database.transaction(RECORDS_STORE, "readwrite");
      const store = transaction.objectStore(RECORDS_STORE);
      const getRequest = store.get(todayKey);

      getRequest.onsuccess = function () {
        if (getRequest.result) {
          resolve(getRequest.result);
          return;
        }

        const now = new Date().toISOString();
        const putRequest = store.put({
          date: todayKey,
          checked: false,
          checkedAt: null,
          createdAt: now,
          updatedAt: now
        });

        putRequest.onsuccess = function () {
          resolve(putRequest.result);
        };
        putRequest.onerror = function () {
          reject(putRequest.error || new Error("Could not create today's record."));
        };
      };

      getRequest.onerror = function () {
        reject(getRequest.error || new Error("Could not read today's record."));
      };
      transaction.onerror = function () {
        reject(transaction.error || new Error("Could not create today's record."));
      };
      transaction.onabort = function () {
        reject(transaction.error || new Error("Today's record transaction was aborted."));
      };
    });
  }

  async function handleHabitSubmit(event) {
    event.preventDefault();
    clearError();

    const formData = new FormData(elements.setupForm);
    const name = String(formData.get("habitName") || "").trim();
    const condition = String(formData.get("condition") || "").trim();
    const criteria = String(formData.get("criteria") || "").trim();

    if (!name || !condition || !criteria) {
      showError("習慣名、実行条件、完了基準をすべて入力してください。");
      return;
    }

    const now = new Date().toISOString();
    const habit = {
      id: HABIT_KEY,
      name: name,
      condition: condition,
      criteria: criteria,
      createdAt: now,
      updatedAt: now
    };

    try {
      await saveHabit(habit);
      currentHabit = habit;
      trackEvent("one_stone_setup_complete");
      renderHabit(currentHabit);
      await refreshRecords();
    } catch (error) {
      trackError("indexeddb_write");
      showError("習慣を保存できませんでした。もう一度試してください。");
      console.error(error);
    }
  }

  async function handleTodayRecord() {
    if (!database || !currentHabit) {
      return;
    }

    elements.todayRecord.disabled = true;
    clearError();

    try {
      await createTodayRecord();
      await refreshRecords();
      announce("今日の記録欄を作成しました。");
    } catch (error) {
      trackError("indexeddb_write");
      elements.todayRecord.disabled = false;
      showError("今日の記録欄を作成できませんでした。もう一度試してください。");
      console.error(error);
    }
  }

  async function handleRecordChange(event) {
    const checkbox = event.target.closest("input[data-date]");
    if (!checkbox || checkbox.dataset.date !== todayKey) {
      return;
    }

    const checked = checkbox.checked;
    checkbox.disabled = true;
    clearError();

    try {
      await saveRecord(todayKey, checked);
      trackEvent(checked ? "one_stone_check_add" : "one_stone_check_cancel");
      announce(checked ? "今日の実行を記録しました。" : "今日の記録を取り消しました。");
      await refreshRecords();
      if (checked) {
        scheduleSurveyPrompt();
      }
    } catch (error) {
      checkbox.checked = !checked;
      trackError("indexeddb_write");
      showError("今日の記録を更新できませんでした。もう一度試してください。");
      console.error(error);
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== "visible") {
      return;
    }

    const nextTodayKey = getDateKey(new Date());
    if (nextTodayKey === todayKey || !database || !currentHabit) {
      return;
    }

    todayKey = nextTodayKey;
    refreshRecords().catch(function (error) {
      trackError("indexeddb_read");
      showError("今日の記録を読み込めませんでした。");
      console.error(error);
    });
  }

  function renderHabit(habit) {
    elements.setupSection.hidden = true;
    elements.tableSection.hidden = false;
    elements.habitColumn.textContent = habit.name;
    elements.habitColumn.title = habit.name;
    trackEvent("one_stone_record_view");
  }

  function showSetup() {
    elements.setupSection.hidden = false;
    elements.tableSection.hidden = true;
    trackEvent("one_stone_setup_view");
  }

  function showTermsModal() {
    termsEndReached = false;
    elements.termsRead.checked = false;
    elements.termsRead.disabled = true;
    elements.termsAgree.disabled = true;
    elements.termsError.hidden = true;
    elements.termsError.textContent = "";
    elements.termsModal.hidden = false;
    document.body.classList.add("terms-open");
    window.requestAnimationFrame(function () {
      updateTermsEndState();
      elements.termsScroll.focus();
    });
  }

  function unlockApp() {
    elements.termsModal.hidden = true;
    elements.appMain.hidden = false;
    document.body.classList.remove("terms-open");
  }

  function handleTermsScroll() {
    updateTermsEndState();
  }

  function updateTermsEndState() {
    if (termsEndReached) {
      return;
    }

    const reachedEnd = elements.termsScroll.scrollTop + elements.termsScroll.clientHeight >= elements.termsScroll.scrollHeight - 4;
    if (!reachedEnd) {
      return;
    }

    termsEndReached = true;
    elements.termsRead.disabled = false;
  }

  function handleTermsReadChange() {
    elements.termsAgree.disabled = !termsEndReached || !elements.termsRead.checked;
  }

  async function handleTermsAgree() {
    if (!termsEndReached || !elements.termsRead.checked || elements.termsAgree.disabled) {
      return;
    }

    elements.termsAgree.disabled = true;
    elements.termsError.hidden = true;
    elements.termsError.textContent = "";

    try {
      await saveTermsConsent();
      unlockApp();
      analyticsEnabled = true;
      startAnalytics();
      trackEvent("one_stone_terms_agree", { terms_version: TERMS_VERSION });
      await loadAppState();
      if (!currentHabit) {
        document.getElementById("habit-name").focus();
      }
    } catch (error) {
      trackError("app_initialization");
      elements.termsAgree.disabled = false;
      if (elements.termsModal.hidden) {
        showError("アプリを読み込めませんでした。ページを再読み込みしてください。");
      } else {
        elements.termsError.textContent = "同意状態を保存できませんでした。もう一度試してください。";
        elements.termsError.hidden = false;
      }
      console.error(error);
    }
  }

  function handleTermsKeydown(event) {
    if (!elements.termsModal || elements.termsModal.hidden || event.key !== "Escape") {
      return;
    }

    event.preventDefault();
  }

  function trackEvent(eventName, parameters) {
    if (!analyticsEnabled || typeof window.gtag !== "function") {
      return;
    }

    if (parameters) {
      window.gtag("event", eventName, parameters);
    } else {
      window.gtag("event", eventName);
    }
  }

  function trackError(errorType) {
    trackEvent("one_stone_error", { error_type: errorType });
  }

  function startAnalytics() {
    loadAnalytics().catch(function (error) {
      console.warn("Google Analytics could not be loaded.", error);
    });
  }

  function loadAnalytics() {
    if (analyticsLoadPromise) {
      return analyticsLoadPromise;
    }

    analyticsLoadPromise = new Promise(function (resolve, reject) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () {
        window.dataLayer.push(arguments);
      };

      window.gtag("js", new Date());
      window.gtag("config", GA_MEASUREMENT_ID, {
        send_page_view: true
      });

      const script = document.createElement("script");
      script.async = true;
      script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_MEASUREMENT_ID);
      script.dataset.oneStoneAnalytics = "true";
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(new Error("Google Analytics script could not be loaded."));
      };
      document.head.appendChild(script);
    });

    return analyticsLoadPromise;
  }

  // ---- アンケート（仕様：アンケート/アンケート仕様.md） ----

  function getSurveyState() {
    const transaction = database.transaction(SETTINGS_STORE, "readonly");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).get(SURVEY_STATE_KEY)).then(function (state) {
      return Object.assign({
        id: SURVEY_STATE_KEY,
        status: "none",
        shownCount: 0,
        firstShownDate: "",
        lastShownDate: "",
        everChecked: false
      }, state || {});
    });
  }

  function saveSurveyState(state) {
    const transaction = database.transaction(SETTINGS_STORE, "readwrite");
    return requestAsPromise(transaction.objectStore(SETTINGS_STORE).put(state));
  }

  async function patchSurveyState(patch) {
    const state = await getSurveyState();
    const next = Object.assign(state, patch);
    await saveSurveyState(next);
    return next;
  }

  async function refreshSurveyButton() {
    try {
      const state = await getSurveyState();
      elements.surveyOpen.hidden = state.status === "answered";
    } catch (error) {
      elements.surveyOpen.hidden = false;
    }
  }

  function canShowSurveyPrompt(state) {
    return (state.status === "none" || state.status === "later") &&
      state.shownCount < 2 &&
      state.lastShownDate !== todayKey;
  }

  async function scheduleSurveyPrompt() {
    try {
      const state = await getSurveyState();
      if (!state.everChecked) {
        state.everChecked = true;
        await saveSurveyState(state);
      }

      if (!canShowSurveyPrompt(state)) {
        return;
      }

      window.clearTimeout(surveyPromptTimer);
      surveyPromptTimer = window.setTimeout(showSurveyPrompt, SURVEY_PROMPT_DELAY_MS);
    } catch (error) {
      console.warn("The survey prompt could not be scheduled.", error);
    }
  }

  async function showSurveyPrompt() {
    try {
      if (!elements.surveyModal.hidden || !elements.surveyPrompt.hidden) {
        return;
      }

      const checkbox = elements.recordsBody.querySelector('input[data-date="' + todayKey + '"]');
      if (!checkbox || !checkbox.checked) {
        return;
      }

      const state = await getSurveyState();
      if (!canShowSurveyPrompt(state)) {
        return;
      }

      surveyPromptNo = state.shownCount + 1;
      await saveSurveyState(Object.assign(state, {
        shownCount: surveyPromptNo,
        status: "later",
        firstShownDate: state.firstShownDate || todayKey,
        lastShownDate: todayKey
      }));

      elements.surveyPromptLater.hidden = surveyPromptNo >= 2;
      elements.surveyPrompt.hidden = false;
      trackEvent("one_stone_survey_prompt_view", { prompt_no: String(surveyPromptNo) });
    } catch (error) {
      console.warn("The survey prompt could not be shown.", error);
    }
  }

  function hideSurveyPrompt() {
    window.clearTimeout(surveyPromptTimer);
    elements.surveyPrompt.hidden = true;
  }

  function handleSurveyPromptAnswer() {
    hideSurveyPrompt();
    openSurvey("prompt" + surveyPromptNo);
  }

  function handleSurveyPromptLater() {
    hideSurveyPrompt();
    trackEvent("one_stone_survey_later");
  }

  function handleSurveyPromptDecline() {
    hideSurveyPrompt();
    trackEvent("one_stone_survey_decline");
    patchSurveyState({ status: "declined" }).catch(function (error) {
      console.warn("The survey state could not be saved.", error);
    });
  }

  function dismissSurveyPrompt() {
    if (surveyPromptNo >= 2) {
      handleSurveyPromptDecline();
    } else {
      handleSurveyPromptLater();
    }
  }

  function handleSurveyOpenClick() {
    openSurvey("button");
  }

  function createSurveyId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  async function openSurvey(source) {
    let reached = false;
    try {
      const state = await getSurveyState();
      reached = state.everChecked === true;
    } catch (error) {
      console.warn("The survey state could not be read.", error);
    }

    survey = {
      rid: createSurveyId(),
      source: source,
      startedAt: Date.now(),
      reached: reached,
      questions: SURVEY_QUESTIONS.filter(function (question) {
        return reached || !question.reachedOnly;
      }),
      step: 0,
      answers: {},
      partialPromise: null,
      submitting: false,
      opener: document.activeElement
    };

    elements.surveyComment.value = "";
    elements.surveyWebsite.value = "";
    elements.surveyCommentCount.textContent = "0 / " + SURVEY_COMMENT_MAX;
    elements.surveyForm.hidden = false;
    elements.surveyDone.hidden = true;
    elements.surveyModal.hidden = false;
    document.body.classList.add("survey-open");
    trackEvent("one_stone_survey_start", { survey_source: source === "button" ? "button" : "prompt" });
    renderSurveyStep();
  }

  function renderSurveyStep() {
    const questionCount = survey.questions.length;
    const isCommentStep = survey.step >= questionCount;

    elements.surveyProgress.textContent = (survey.step + 1) + " / " + (questionCount + 1);
    elements.surveyNotice.hidden = survey.step !== 0;
    elements.surveyQuestionBlock.hidden = isCommentStep;
    elements.surveyCommentBlock.hidden = !isCommentStep;
    elements.surveyBack.hidden = survey.step === 0;
    elements.surveyNext.hidden = isCommentStep;
    elements.surveySubmit.hidden = !isCommentStep;
    elements.surveyError.hidden = true;
    elements.surveyError.textContent = "";

    if (isCommentStep) {
      elements.surveyComment.focus();
      return;
    }

    const question = survey.questions[survey.step];
    const selected = survey.answers[question.id];
    elements.surveyQuestionText.textContent = question.text;
    elements.surveyScale.querySelectorAll("input").forEach(function (input) {
      input.checked = selected === Number(input.value);
    });
    elements.surveyNext.disabled = !selected;

    const target = elements.surveyScale.querySelector("input:checked") || elements.surveyScale.querySelector("input");
    target.focus();
  }

  function handleSurveyScaleChange(event) {
    if (!survey || !event.target.matches("input")) {
      return;
    }

    const question = survey.questions[survey.step];
    survey.answers[question.id] = Number(event.target.value);
    elements.surveyNext.disabled = false;

    if (survey.step === 0 && !survey.partialPromise) {
      sendPartialSurvey();
    }
  }

  function handleSurveyCommentInput() {
    elements.surveyCommentCount.textContent = elements.surveyComment.value.length + " / " + SURVEY_COMMENT_MAX;
  }

  function handleSurveyBack() {
    if (survey && survey.step > 0) {
      survey.step -= 1;
      renderSurveyStep();
    }
  }

  function handleSurveyNext() {
    if (survey && survey.step < survey.questions.length) {
      survey.step += 1;
      renderSurveyStep();
    }
  }

  function buildSurveyPayload(complete) {
    const payload = {
      rid: survey.rid,
      survey_version: SURVEY_VERSION,
      app_version: APP_VERSION,
      reached_check: survey.reached ? "yes" : "no",
      source: survey.source,
      complete: complete ? "true" : "false",
      elapsed_sec: String(Math.min(86400, Math.max(0, Math.round((Date.now() - survey.startedAt) / 1000))))
    };

    survey.questions.forEach(function (question) {
      if (survey.answers[question.id]) {
        payload[question.id] = String(survey.answers[question.id]);
      }
    });

    const comment = elements.surveyComment.value.trim().slice(0, SURVEY_COMMENT_MAX);
    if (comment) {
      payload.comment = comment;
    }

    return payload;
  }

  async function postSurvey(payload) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? window.setTimeout(function () {
      controller.abort();
    }, SURVEY_POST_TIMEOUT_MS) : 0;

    try {
      const response = await fetch(SURVEY_ENDPOINT, {
        method: "POST",
        body: new URLSearchParams(payload),
        signal: controller ? controller.signal : undefined
      });
      const result = await response.json();
      return Boolean(result && result.ok === true);
    } finally {
      window.clearTimeout(timer);
    }
  }

  function sendPartialSurvey() {
    if (elements.surveyWebsite.value) {
      return;
    }

    survey.partialPromise = postSurvey(buildSurveyPayload(false)).catch(function (error) {
      console.warn("The partial survey answer could not be sent.", error);
      return false;
    });
  }

  async function submitSurvey() {
    if (!survey || survey.submitting) {
      return;
    }

    if (elements.surveyWebsite.value) {
      showSurveyDone();
      return;
    }

    survey.submitting = true;
    elements.surveySubmit.disabled = true;
    elements.surveyError.hidden = true;
    elements.surveyError.textContent = "";

    try {
      if (survey.partialPromise) {
        await survey.partialPromise;
      }

      const accepted = await postSurvey(buildSurveyPayload(true));
      if (!accepted) {
        throw new Error("The survey endpoint did not accept the answer.");
      }

      await patchSurveyState({ status: "answered" }).catch(function (error) {
        console.warn("The survey state could not be saved.", error);
      });
      trackEvent("one_stone_survey_submit", { survey_source: survey.source === "button" ? "button" : "prompt" });
      showSurveyDone();
    } catch (error) {
      elements.surveyError.textContent = "送信できませんでした。通信をご確認のうえ、もう一度お試しください";
      elements.surveyError.hidden = false;
      console.warn("The survey answer could not be sent.", error);
    } finally {
      survey.submitting = false;
      elements.surveySubmit.disabled = false;
    }
  }

  function showSurveyDone() {
    elements.surveyForm.hidden = true;
    elements.surveyDone.hidden = false;
    elements.surveyOpen.hidden = true;
    elements.surveyDoneClose.focus();
  }

  function closeSurvey() {
    if (!survey || survey.submitting) {
      return;
    }

    const opener = survey.opener;
    survey = null;
    elements.surveyModal.hidden = true;
    document.body.classList.remove("survey-open");

    if (opener && document.contains(opener) && typeof opener.focus === "function" && !opener.hidden) {
      opener.focus();
    }
  }

  function handleSurveyKeydown(event) {
    if (!elements.surveyModal.hidden) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSurvey();
      } else if (event.key === "Tab") {
        trapSurveyFocus(event);
      }
      return;
    }

    if (event.key === "Escape" && !elements.surveyPrompt.hidden && elements.surveyPrompt.contains(document.activeElement)) {
      event.preventDefault();
      dismissSurveyPrompt();
    }
  }

  function trapSurveyFocus(event) {
    const focusable = Array.from(elements.surveyModal.querySelectorAll("button, input, textarea")).filter(function (element) {
      return !element.disabled && !element.closest("[hidden]") && element.tabIndex >= 0;
    });
    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function refreshRecords() {
    const records = await getRecords();
    renderRecordTable(records);
  }

  function renderRecordTable(records) {
    const recordByDate = new Map();

    records.forEach(function (record) {
      if (record.date <= todayKey) {
        recordByDate.set(record.date, record);
      }
    });

    const dates = Array.from(recordByDate.keys()).sort(function (first, second) {
      return second.localeCompare(first);
    });

    elements.recordsBody.textContent = "";

    dates.forEach(function (date) {
      const row = document.createElement("tr");
      if (date === todayKey) {
        row.className = "is-today";
      }

      const dateCell = document.createElement("td");
      const dateLabel = document.createElement("time");
      dateLabel.dateTime = date;
      dateLabel.textContent = formatDate(date);
      dateCell.append(dateLabel);

      const checkCell = document.createElement("td");
      checkCell.className = "check-cell";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isRecordChecked(recordByDate.get(date));
      checkbox.dataset.date = date;
      checkbox.disabled = date !== todayKey;
      checkbox.setAttribute("aria-label", formatDate(date) + "の実行");

      checkCell.append(checkbox);
      row.append(dateCell, checkCell);
      elements.recordsBody.append(row);
    });

    const hasRecords = dates.length > 0;
    elements.emptyState.hidden = hasRecords;
    elements.recordTableContainer.hidden = !hasRecords;
    elements.todayRecord.hidden = recordByDate.has(todayKey);
    elements.todayRecord.disabled = false;
  }

  function isRecordChecked(record) {
    if (!record) {
      return false;
    }

    return record.checked === true || (record.checked === undefined && Boolean(record.checkedAt));
  }

  function getDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function formatDate(dateKey) {
    return dateKey.replace(/-/g, "/");
  }

  function announce(message) {
    elements.tableStatus.textContent = message;
  }

  function showError(message) {
    elements.error.textContent = message;
    elements.error.hidden = false;
  }

  function clearError() {
    elements.error.textContent = "";
    elements.error.hidden = true;
  }
})();
