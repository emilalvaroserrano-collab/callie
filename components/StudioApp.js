'use client';

import { useEffect } from 'react';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { getDatabase, ref, get } from 'firebase/database';

import { ALL_LANGUAGES, PRIMARY_LANGUAGES } from '@/lib/languages';

const STORAGE_KEY = 'alex-persona-studio-v1';
const REDIRECT_GUARD_KEY = 'csr-redirect-guard';
const AUTH_URL = '/auth';
const DEFAULT_FIRST_MESSAGE =
  'Hey there, thanks for calling {{company}}, this is {{persona}}. Who am I speaking with today, and what can I help you with?';
const VOICES = new Set(['Elliot', 'Emma', 'Clara', 'Kai', 'Godfrey', 'Sid', 'Savannah', 'Layla']);

export default function StudioApp({ firebaseConfig, vapiConfig }) {
  useEffect(() => {
    const fbApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const fbAuth = getAuth(fbApp);
    const fbDb = getDatabase(fbApp);
    const languageSet = new Set([...PRIMARY_LANGUAGES, ...ALL_LANGUAGES]);
    const kbCache = new Map();
    const $ = (id) => document.getElementById(id);

    const VAPI_PUBLIC_KEY = vapiConfig.publicKey || '';
    const VAPI_ASSISTANT_ID = vapiConfig.assistantId || '';

    let profiles = [];
    let currentId = '';
    let dirty = false;
    let creatingCSR = false;
    let mobileDialerOpen = false;
    let callState = 'idle';
    let vapi = null;
    let muted = false;
    let speaking = false;
    let sessionId = null;
    let startedAt = null;
    let finalDuration = 0;
    let interval = null;
    let clockInterval = null;
    let transcript = [];
    let partial = null;
    let activePersona = null;
    let lastPersona = null;
    let requestSerial = 0;
    let toastTimer = null;
    let activeRingCtx = null;
    let studioInitialized = false;
    let authRedirecting = false;
    let disposed = false;
    let authGraceTimer = null;

    /* ---------- WhatsApp reports ---------- */
    const WA_SETTINGS_KEY = 'alex-whatsapp-reports-v1';
    let waSettings = { autoSend: true, destination: '' };
    let waSession = null;
    let waConfigured = false;
    let waReachable = true;
    let waPollTimer = null;
    let waModalOpen = false;
    let waConnecting = false;
    let waStartedAtIso = null;

    /* ---------- Gmail integration ---------- */
    let gmailConnected = false;
    let gmailEmail = '';
    let gmailConfigured = false;

    const makeId = () =>
      window.crypto?.randomUUID?.() || `p-${Date.now()}-${Math.floor(Math.random() * 1e8)}`;

    const defaultProfile = () => ({
      id: makeId(),
      name: 'Alex',
      company: 'TechSolutions',
      website: '',
      websiteKnowledge: '',
      websiteKnowledgeUrl: '',
      voice: 'Elliot',
      language: 'English',
      firstMessage: DEFAULT_FIRST_MESSAGE
    });

    function renderLanguageOptions() {
      const select = $('languageSelect');
      select.replaceChildren();
      const popular = document.createElement('optgroup');
      popular.label = 'Popular';
      PRIMARY_LANGUAGES.forEach((language) => popular.appendChild(new Option(language, language)));
      select.appendChild(popular);
      const all = document.createElement('optgroup');
      all.label = 'All languages';
      ALL_LANGUAGES.forEach((language) => all.appendChild(new Option(language, language)));
      select.appendChild(all);
    }

    function normalizeUrl(raw) {
      const value = (raw || '').trim();
      if (!value) return '';
      return /^https?:\/\//i.test(value) ? value : `https://${value}`;
    }

    function saveStore() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ currentId, profiles }));
        return true;
      } catch (error) {
        $('saveStatus').textContent = 'Browser storage unavailable; your edits are temporary.';
        return false;
      }
    }

    function hydrateFirstMessage(persona) {
      const name = persona.name || 'Alex';
      const company = persona.company || 'your company';
      const message =
        typeof persona.firstMessage === 'string' && persona.firstMessage.trim()
          ? persona.firstMessage.trim()
          : DEFAULT_FIRST_MESSAGE;
      return message.replaceAll('{{persona}}', name).replaceAll('{{company}}', company);
    }

    function loadStore() {
      try {
        const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (data && Array.isArray(data.profiles)) {
          profiles = data.profiles
            .filter((profile) => profile && typeof profile.id === 'string')
            .map((profile) => ({
              id: profile.id,
              name: typeof profile.name === 'string' ? profile.name : 'Alex',
              company: typeof profile.company === 'string' ? profile.company : 'TechSolutions',
              website: typeof profile.website === 'string' ? profile.website : '',
              websiteKnowledge:
                typeof profile.websiteKnowledge === 'string' ? profile.websiteKnowledge : '',
              websiteKnowledgeUrl:
                typeof profile.websiteKnowledgeUrl === 'string'
                  ? profile.websiteKnowledgeUrl
                  : '',
              voice: VOICES.has(profile.voice) ? profile.voice : 'Elliot',
              language: languageSet.has(profile.language) ? profile.language : 'English',
              firstMessage:
                typeof profile.firstMessage === 'string' && profile.firstMessage.trim()
                  ? profile.firstMessage
                  : DEFAULT_FIRST_MESSAGE
            }))
            .slice(0, 40);
          currentId = data.currentId;
        }
      } catch (error) {}
      if (!profiles.length) {
        profiles = [defaultProfile()];
        currentId = profiles[0].id;
        saveStore();
      }
      if (!profiles.some((profile) => profile.id === currentId)) currentId = profiles[0].id;
      profiles.forEach((profile) => {
        if (profile.website && profile.websiteKnowledge && profile.websiteKnowledgeUrl === profile.website) {
          kbCache.set(profile.website, profile.websiteKnowledge);
        }
      });
    }

    function selected() {
      return profiles.find((profile) => profile.id === currentId) || profiles[0];
    }

    function editorData() {
      const current = selected();
      const rawUrl = $('websiteUrl').value.trim();
      const normalizedUrl = rawUrl ? normalizeUrl(rawUrl) : '';
      const keepKnowledge =
        normalizedUrl &&
        current &&
        current.websiteKnowledgeUrl === normalizedUrl &&
        current.websiteKnowledge;
      return {
        id: currentId,
        name: $('personaName').value.trim(),
        company: $('companyName').value.trim(),
        website: rawUrl,
        websiteKnowledge: keepKnowledge
          ? current.websiteKnowledge
          : kbCache.get(normalizedUrl) || '',
        websiteKnowledgeUrl:
          keepKnowledge || kbCache.has(normalizedUrl) ? normalizedUrl : '',
        voice: $('voiceSelect').value,
        language: $('languageSelect').value || 'English',
        firstMessage: $('firstMessage').value.trim()
      };
    }

    function validate(data) {
      if (!data.name) {
        showToast('Add an assistant name first.', true);
        $('personaName').focus();
        return false;
      }
      if (!data.company) {
        showToast('Add a company name first.', true);
        $('companyName').focus();
        return false;
      }
      if (data.website) {
        const normalized = normalizeUrl(data.website);
        try {
          const url = new URL(normalized);
          if (
            !/^https?:$/i.test(url.protocol) ||
            (!url.hostname.includes('.') && url.hostname !== 'localhost')
          ) {
            throw new Error('invalid');
          }
          data.website = url.href;
          if (data.websiteKnowledgeUrl && data.websiteKnowledgeUrl !== data.website) {
            data.websiteKnowledge = '';
            data.websiteKnowledgeUrl = '';
          }
        } catch (error) {
          showToast('Enter a valid website URL (e.g. https://company.com).', true);
          $('websiteUrl').focus();
          return false;
        }
      }
      if (!data.firstMessage) {
        showToast('Add an agent first message.', true);
        $('firstMessage').focus();
        return false;
      }
      if (!VOICES.has(data.voice)) {
        showToast('Choose a supported voice.', true);
        return false;
      }
      if (!languageSet.has(data.language)) {
        showToast('Choose a supported main language.', true);
        return false;
      }
      return true;
    }

    function fillEditor(profile) {
      $('personaName').value = profile.name;
      $('companyName').value = profile.company;
      $('websiteUrl').value = profile.website || '';
      $('voiceSelect').value = profile.voice;
      $('languageSelect').value = languageSet.has(profile.language)
        ? profile.language
        : 'English';
      $('firstMessage').value = profile.firstMessage || DEFAULT_FIRST_MESSAGE;
      dirty = false;
      refreshDirty();
      renderPreview();
    }

    function renderProfileList() {
      const select = $('profiles');
      select.replaceChildren();
      profiles.forEach((profile) => {
        select.add(new Option(`${profile.name} · ${profile.company}`, profile.id));
      });
      select.value = currentId;
      $('deleteProfile').disabled = profiles.length === 1;
    }

    function refreshDirty() {
      $('saveStatus').textContent = dirty ? 'Unsaved changes' : '';
    }

    function renderPreview() {
      if (callState !== 'idle' && activePersona) return;
      const persona = editorData();
      $('phoneName').textContent = persona.name || 'Your agent';
      $('phoneCompany').textContent = persona.company || 'Your company';
      $('avatar').textContent = (persona.name || 'A').trim().slice(0, 1).toUpperCase();
    }

    function applyActive(persona) {
      $('phoneName').textContent = persona.name;
      $('phoneCompany').textContent = persona.company;
      $('avatar').textContent = persona.name.slice(0, 1).toUpperCase();
    }

    function setDirty() {
      dirty = true;
      refreshDirty();
      renderPreview();
      if (callState !== 'idle') $('saveStatus').textContent = 'Changes apply to the next call.';
    }

    function showToast(message, error = false) {
      const toast = $('toast');
      toast.textContent = message;
      toast.classList.toggle('error', error);
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 3400);
    }

    async function fetchWebsiteKnowledge(url, timeoutMs = 3500) {
      const target = normalizeUrl(url);
      if (!target) return '';
      if (kbCache.has(target)) return kbCache.get(target);

      const cleanText = (raw) =>
        raw
          .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, 5500);

      const tryFetch = async (endpoint, headers = {}) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(endpoint, { signal: controller.signal, headers });
          if (!response.ok) return '';
          return cleanText(await response.text());
        } catch (error) {
          return '';
        } finally {
          clearTimeout(timer);
        }
      };

      let text = await tryFetch(`https://r.jina.ai/${target}`, { Accept: 'text/plain' });
      if (!text || text.length < 60) {
        const direct = await tryFetch(target);
        if (direct && direct.length > (text?.length || 0)) text = direct;
      }
      if (text && text.length >= 40) {
        kbCache.set(target, text);
        return text;
      }
      return '';
    }

    function prefetchWebsiteKnowledge(profile) {
      if (!profile?.website) return;
      const target = profile.website;
      fetchWebsiteKnowledge(target, 4000).then((knowledge) => {
        if (!knowledge) return;
        const index = profiles.findIndex((item) => item.id === profile.id);
        if (index >= 0 && profiles[index].website === target) {
          profiles[index].websiteKnowledge = knowledge;
          profiles[index].websiteKnowledgeUrl = target;
          saveStore();
        }
      });
    }

    function savePersona() {
      if (creatingCSR) return;
      const persona = editorData();
      if (!validate(persona)) return;
      $('websiteUrl').value = persona.website || '';
      const index = profiles.findIndex((item) => item.id === currentId);
      if (index < 0) {
        showToast('Select a CSR profile first.', true);
        return;
      }
      profiles[index] = persona;
      const persisted = saveStore();
      dirty = false;
      renderProfileList();
      refreshDirty();
      applyActive(persona);
      $('mobileAgentName').textContent = persona.name;
      $('mobileAgentCompany').textContent = persona.company;
      prefetchWebsiteKnowledge(persona);
      if (window.matchMedia('(max-width:980px)').matches) {
        creatingCSR = true;
        $('saveProfile').disabled = true;
        $('createOverlay').classList.add('open');
        $('createOverlay').setAttribute('aria-hidden', 'false');
        window.setTimeout(() => {
          mobileDialerOpen = true;
          document.body.classList.add('mobile-dialer');
          $('createOverlay').classList.remove('open');
          $('createOverlay').setAttribute('aria-hidden', 'true');
          creatingCSR = false;
          $('saveProfile').disabled = false;
          $('backToEditor').focus({ preventScroll: true });
          showToast(
            persisted
              ? 'Your CSR is ready to call.'
              : 'CSR is ready for this session; browser saving is unavailable.',
            !persisted
          );
        }, 800);
      } else {
        showToast(
          persisted
            ? 'CSR saved. Use the dialer to test it.'
            : 'CSR ready for this session; browser save unavailable.',
          !persisted
        );
      }
    }

    function updateClock() {
      $('phoneClock').textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function formatDuration(seconds) {
      seconds = Math.max(0, Math.floor(seconds));
      return (
        String(Math.floor(seconds / 60)).padStart(2, '0') +
        ':' +
        String(seconds % 60).padStart(2, '0')
      );
    }

    function updateTimer() {
      if (startedAt) finalDuration = Math.floor((Date.now() - startedAt) / 1000);
      $('callDuration').textContent = formatDuration(finalDuration);
    }

    function setCallState(state, message) {
      callState = state;
      const live = state === 'connected';
      $('callState').classList.toggle('connected', live);
      $('callStatusText').textContent =
        message ||
        {
          idle: 'Ready to connect',
          connecting: 'Connecting securely…',
          connected: 'Connected · Listening',
          ending: 'Ending call…'
        }[state];
      $('callBtn').disabled = state === 'connecting' || state === 'ending';
      $('callBtn').classList.toggle('end', live);
      $('callBtn').setAttribute('aria-label', live ? 'End web voice call' : 'Start a web voice call');
      $('callBtn').title = live ? 'End call' : 'Start call';
      $('callBtnLabel').textContent = live
        ? 'End call'
        : state === 'idle'
          ? 'Call'
          : state === 'connecting'
            ? 'Connecting'
            : 'Ending';
      $('callIcon').innerHTML = live
        ? '<path d="M3 8a14.7 14.7 0 0 1 18 0l-2.5 4.4a1.8 1.8 0 0 1-2.1.8L14 12a2.5 2.5 0 0 0-4 0l-2.4 1.2a1.8 1.8 0 0 1-2.1-.8L3 8z"/>'
        : '<path d="M22 16.8V20a2 2 0 0 1-2.2 2A18.8 18.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3.2a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 1.9L7.6 10A15 15 0 0 0 14 16.4l1.4-1.5a2 2 0 0 1 1.9-.6l3 .5a2 2 0 0 1 1.7 2z"/>';
      $('muteBtn').disabled = !live;
      if (!live) {
        muted = false;
        updateMute();
      }
      $('audioVisualizer').classList.toggle('active', live && speaking);
      $('phoneFooter').textContent = live
        ? 'Encrypted browser connection · Active session'
        : state === 'connecting'
          ? 'Connecting to Vapi…'
          : 'Web voice call · No phone number needed';
      if (state === 'idle') {
        clearInterval(interval);
        interval = null;
        activePersona = null;
        renderPreview();
      }
    }

    function updateMute() {
      $('muteBtn').classList.toggle('muted', muted);
      $('muteBtn').setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
      $('muteLabel').textContent = muted ? 'Unmute' : 'Mute';
      $('muteIcon').innerHTML = muted
        ? '<path d="M2 2l20 20M9 9v2a3 3 0 0 0 5 2M15 9V5a3 3 0 0 0-6 0v1M5 10a7 7 0 0 0 12 5M19 10a7 7 0 0 1-1 3M12 17v5M8 22h8"/>'
        : '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>';
    }

    async function requestOverrides(persona) {
      const token = await fbAuth.currentUser?.getIdToken();
      if (!token) throw new Error('Your session expired. Please sign in again.');
      const response = await fetch('/api/vapi-overrides', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          name: persona.name,
          company: persona.company,
          website: persona.website || '',
          websiteKnowledge: persona.websiteKnowledge || '',
          websiteKnowledgeUrl: persona.websiteKnowledgeUrl || '',
          voice: persona.voice,
          language: persona.language || 'English',
          firstMessage: persona.firstMessage || ''
        })
      });
      let data = null;
      try {
        data = await response.json();
      } catch (error) {}
      if (!response.ok) {
        throw new Error(data?.error || 'Unable to prepare this call.');
      }
      if (!data?.overrides) throw new Error('Voice configuration unavailable.');
      return data.overrides;
    }

    function closeRingAudio() {
      if (activeRingCtx) {
        try {
          activeRingCtx.close();
        } catch (error) {}
        activeRingCtx = null;
      }
    }

    async function playRingTones(context, count = 3, isAborted = () => false) {
      const ringDuration = 0.42;
      const gapDuration = 0.3;
      const tailDuration = 0.22;
      const totalMs = Math.round(
        (count * ringDuration + (count - 1) * gapDuration + tailDuration) * 1000
      );
      if (context) {
        try {
          if (context.state === 'suspended') {
            /* Ring tones are cosmetic - never let a stuck AudioContext block the call. */
            await Promise.race([
              context.resume().catch(() => {}),
              new Promise((resolve) => setTimeout(resolve, 300))
            ]);
          }
          const now = context.currentTime + 0.04;
          for (let index = 0; index < count; index++) {
            const start = now + index * (ringDuration + gapDuration);
            const end = start + ringDuration;
            const gain = context.createGain();
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.linearRampToValueAtTime(0.11, start + 0.025);
            gain.gain.setValueAtTime(0.11, end - 0.03);
            gain.gain.linearRampToValueAtTime(0.0001, end);
            gain.connect(context.destination);
            const osc1 = context.createOscillator();
            const osc2 = context.createOscillator();
            osc1.type = 'sine';
            osc2.type = 'sine';
            osc1.frequency.setValueAtTime(440, start);
            osc2.frequency.setValueAtTime(480, start);
            osc1.connect(gain);
            osc2.connect(gain);
            osc1.start(start);
            osc2.start(start);
            osc1.stop(end + 0.01);
            osc2.stop(end + 0.01);
          }
        } catch (error) {}
      }
      const deadline = Date.now() + totalMs;
      while (Date.now() < deadline) {
        if (isAborted()) break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(80, Math.max(10, deadline - Date.now())))
        );
      }
      closeRingAudio();
    }

    async function fetchSdk() {
      try {
        const module = await import('@vapi-ai/web');
        const Vapi = module?.default || module?.Vapi;
        if (typeof Vapi !== 'function') throw new Error('SDK module has no default export');
        return Vapi;
      } catch (error) {
        throw new Error(
          'Vapi SDK unavailable. Confirm your internet connection and try again. ' +
            (error?.message || error)
        );
      }
    }

    function attachEvents(client, serial) {
      const isCurrent = () => serial === requestSerial && vapi === client;
      client.on('call-start', () => {
        if (!isCurrent()) return;
        startedAt = Date.now();
        waStartedAtIso = new Date(startedAt).toISOString();
        finalDuration = 0;
        updateTimer();
        clearInterval(interval);
        interval = setInterval(updateTimer, 1000);
        setCallState('connected', 'Connected · Listening');
      });
      client.on('call-end', () => {
        if (!isCurrent()) return;
        partial = null;
        renderTranscript();
        const callStarted = startedAt;
        const callStartedIso = waStartedAtIso;
        const callDuration = callStarted
          ? Math.max(0, Math.floor((Date.now() - callStarted) / 1000))
          : finalDuration;
        const callPersona = activePersona
          ? (typeof structuredClone === 'function'
              ? structuredClone(activePersona)
              : JSON.parse(JSON.stringify(activePersona)))
          : lastPersona || null;
        const callTranscript = transcript.map((line) => ({
          role: line.role,
          text: line.text,
          at: line.at
        }));
        const callId = sessionId;
        const shouldReport = Boolean(callStarted) && !!callPersona;
        if (startedAt) updateTimer();
        startedAt = null;
        waStartedAtIso = null;
        speaking = false;
        setCallState('idle', 'Call ended');
        showToast('Call ended. Transcript is available locally.');
        if (shouldReport) {
          sendCallSummary({
            persona: {
              name: callPersona.name,
              company: callPersona.company
            },
            callId,
            durationSeconds: callDuration,
            startedAt: callStartedIso || new Date(Date.now() - callDuration * 1000).toISOString(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            destination: waSettings.destination,
            transcript: callTranscript
          }).catch(() => {});
        }
      });
      client.on('speech-start', () => {
        if (!isCurrent()) return;
        speaking = true;
        $('audioVisualizer').classList.add('active');
        if (callState === 'connected') $('callStatusText').textContent = 'Assistant speaking';
      });
      client.on('speech-end', () => {
        if (!isCurrent()) return;
        speaking = false;
        $('audioVisualizer').classList.remove('active');
        if (callState === 'connected') $('callStatusText').textContent = 'Connected · Listening';
      });
      client.on('message', (message) => {
        if (!isCurrent()) return;
        if (message?.type === 'transcript' && typeof message.transcript === 'string') {
          const role = message.role === 'user' ? 'user' : 'assistant';
          const line = {
            role,
            text: message.transcript,
            at: new Date().toLocaleTimeString()
          };
          if (message.transcriptType === 'final') {
            transcript.push(line);
            partial = null;
          } else {
            partial = line;
          }
          renderTranscript();
        }
      });
      client.on('error', (error) => {
        if (!isCurrent()) return;
        const message = (
          error?.message ||
          error?.error?.message ||
          'Call connection error'
        ).toString();
        console.error('Vapi call error', error);
        showToast(message.slice(0, 160), true);
        if (callState === 'connecting' || callState === 'ending') {
          startedAt = null;
          speaking = false;
          setCallState('idle', 'Could not connect');
        }
      });
    }

    async function startCall() {
      if (callState !== 'idle') return;
      const persona =
        mobileDialerOpen && window.matchMedia('(max-width:980px)').matches
          ? selected()
          : editorData();
      if (!validate(persona)) return;
      if (!VAPI_PUBLIC_KEY || !VAPI_ASSISTANT_ID) {
        showToast(
          'Voice calling is not configured. Set the Vapi environment variables in Vercel and redeploy.',
          true
        );
        return;
      }
      if (!window.isSecureContext) {
        showToast(
          'Microphone requires HTTPS or localhost. Open this page from a secure origin.',
          true
        );
        return;
      }
      closeRingAudio();
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          activeRingCtx = new AudioContext();
          if (activeRingCtx.state === 'suspended') activeRingCtx.resume().catch(() => {});
        }
      } catch (error) {
        activeRingCtx = null;
      }
      const serial = ++requestSerial;
      activePersona =
        typeof structuredClone === 'function'
          ? structuredClone(persona)
          : JSON.parse(JSON.stringify(persona));
      applyActive(activePersona);
      transcript = [];
      partial = null;
      sessionId = null;
      startedAt = null;
      finalDuration = 0;
      $('callDuration').textContent = '00:00';
      renderTranscript();
      setCallState('connecting', 'Ringing…');
      try {
        const sdkPromise = fetchSdk();
        const knowledgePromise =
          activePersona.website &&
          !(
            activePersona.websiteKnowledgeUrl === activePersona.website &&
            activePersona.websiteKnowledge
          )
            ? fetchWebsiteKnowledge(activePersona.website, 2200)
            : Promise.resolve(activePersona.websiteKnowledge || '');
        await playRingTones(activeRingCtx, 3, () => serial !== requestSerial);
        if (serial !== requestSerial) return;
        $('callStatusText').textContent = 'Loading voice SDK…';
        const [Vapi, knowledgeText] = await Promise.all([sdkPromise, knowledgePromise]);
        if (serial !== requestSerial) return;
        if (knowledgeText && activePersona.website) {
          activePersona.websiteKnowledge = knowledgeText;
          activePersona.websiteKnowledgeUrl = activePersona.website;
          const index = profiles.findIndex((item) => item.id === activePersona.id);
          if (index >= 0 && profiles[index].website === activePersona.website) {
            profiles[index].websiteKnowledge = knowledgeText;
            profiles[index].websiteKnowledgeUrl = activePersona.website;
            saveStore();
          }
        }
        $('callStatusText').textContent = 'Preparing voice…';
        const overrides = await requestOverrides(activePersona);
        if (serial !== requestSerial) return;
        const client = new Vapi(VAPI_PUBLIC_KEY);
        vapi = client;
        attachEvents(client, serial);
        $('callStatusText').textContent = 'Requesting microphone…';
        const call = await client.start(VAPI_ASSISTANT_ID, overrides);
        if (!Number.isFinite(serial) || serial !== requestSerial) return;
        sessionId = call?.id || call?.call?.id || null;
        if (callState === 'connecting') $('callStatusText').textContent = 'Waiting for connection…';
      } catch (error) {
        closeRingAudio();
        if (serial !== requestSerial) return;
        console.error('Failed to start Vapi call', error);
        showToast((error?.message || String(error)).slice(0, 180), true);
        startedAt = null;
        speaking = false;
        setCallState('idle', 'Connection failed');
      }
    }

    function stopCall() {
      if (callState !== 'connected' || !vapi) return;
      setCallState('ending', 'Ending call…');
      try {
        vapi.stop();
      } catch (error) {
        showToast('Unable to end call: ' + String(error?.message || error), true);
        setCallState('connected', 'Connected');
      }
    }

    function renderTranscript() {
      const content = $('transcriptContent');
      content.replaceChildren();
      const lines = partial ? [...transcript, partial] : transcript;
      if (!lines.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-transcript';
        empty.textContent = 'Your conversation will appear here when the call starts.';
        content.appendChild(empty);
        return;
      }
      for (const line of lines) {
        const bubble = document.createElement('div');
        bubble.className = 'bubble ' + (line.role === 'user' ? 'user' : 'assistant');
        const head = document.createElement('em');
        head.textContent =
          line.role === 'user'
            ? 'You'
            : activePersona?.name || lastPersona?.name || $('personaName').value || 'Assistant';
        bubble.appendChild(head);
        const text = document.createElement('span');
        text.textContent = line.text + (partial === line ? ' …' : '');
        bubble.appendChild(text);
        content.appendChild(bubble);
      }
      content.scrollTop = content.scrollHeight;
    }

    function toggleTray(open) {
      $('transcriptTray').classList.toggle('open', open);
      $('transcriptTray').setAttribute('aria-hidden', String(!open));
      if (open) renderTranscript();
    }

    function downloadTranscript() {
      if (!transcript.length) {
        showToast('No final transcript messages to export yet.', true);
        return;
      }
      const persona = activePersona || lastPersona || editorData();
      const text = [
        `Persona: ${persona.name}`,
        `Company: ${persona.company}`,
        persona.website ? `Website: ${persona.website}` : '',
        `Main language: ${persona.language || 'English'}`,
        `Vapi call ID: ${sessionId || 'Not available'}`,
        `Local duration: ${formatDuration(finalDuration)}`,
        '',
        'Transcript:',
        ...transcript.map(
          (line) =>
            `[${line.at}] ${line.role === 'user' ? 'Caller' : persona.name}: ${line.text}`
        )
      ]
        .filter(Boolean)
        .join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `voice-call-transcript-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* ---------- Auth gate: redirect helpers ---------- */
    function clearRedirectGuard() {
      try {
        sessionStorage.removeItem(REDIRECT_GUARD_KEY);
      } catch (error) {}
    }

    /* Stops a redirect ping-pong with the auth page when the session can't settle. */
    function redirectCountExceeded() {
      try {
        const now = Date.now();
        const hops = JSON.parse(sessionStorage.getItem(REDIRECT_GUARD_KEY) || '[]')
          .filter((time) => typeof time === 'number' && now - time < 6000);
        hops.push(now);
        sessionStorage.setItem(REDIRECT_GUARD_KEY, JSON.stringify(hops));
        return hops.length > 3;
      } catch (error) {
        return false;
      }
    }

    function showGateError() {
      const gate = $('authGate');
      if (!gate) return;
      gate.innerHTML =
        '<div class="gate-error" style="max-width:420px;padding:24px;text-align:center;font-size:14px;line-height:1.6">We could not verify your session.<br><a href="' +
        AUTH_URL +
        '" style="color:var(--mint);font-weight:600">Go to sign in</a></div>';
    }

    function goToAuth() {
      if (authRedirecting) return;
      authRedirecting = true;
      if (redirectCountExceeded()) {
        authRedirecting = false;
        showGateError();
        return;
      }
      const here = location.pathname + location.search + location.hash;
      const target =
        here === '/' ? AUTH_URL : `${AUTH_URL}?next=${encodeURIComponent(here)}`;
      window.location.replace(target);
    }

    async function renderSignedInUser(user) {
      let displayName = user.displayName || (user.email ? user.email.split('@')[0] : 'Account');
      let photoURL = user.photoURL || '';
      try {
        /* Never let a slow RTDB read hold up the app. */
        const snap = await Promise.race([
          get(ref(fbDb, `users/${user.uid}`)),
          new Promise((resolve) => setTimeout(() => resolve(null), 2500))
        ]);
        if (snap && snap.exists()) {
          const data = snap.val();
          if (data?.displayName) displayName = data.displayName;
          if (data?.photoURL) photoURL = data.photoURL;
        }
      } catch (error) {}
      $('userName').textContent = displayName;
      const avatar = $('userAvatar');
      avatar.replaceChildren();
      if (photoURL) {
        const image = document.createElement('img');
        image.src = photoURL;
        image.alt = displayName;
        image.referrerPolicy = 'no-referrer';
        avatar.appendChild(image);
      } else {
        avatar.textContent = (displayName || 'U').trim().slice(0, 1).toUpperCase();
      }
    }

    function initStudio() {
      if (studioInitialized) return;
      studioInitialized = true;
      renderLanguageOptions();
      loadStore();
      renderProfileList();
      fillEditor(selected());
      $('mobileAgentName').textContent = selected().name;
      $('mobileAgentCompany').textContent = selected().company;
      updateClock();
      clockInterval = setInterval(updateClock, 30_000);
      setCallState('idle');
      initWhatsApp().catch(() => {});
      gmailFetchStatus().catch(() => {});

      // Handle Gmail OAuth callback redirect.
      try {
        const params = new URLSearchParams(location.search);
        if (params.get('gmail') === 'connected') {
          gmailConnected = true;
          gmailFetchStatus().catch(() => {});
          showToast('Gmail connected successfully.');
        } else if (params.get('gmail') === 'error') {
          showToast(`Gmail connection failed: ${params.get('reason') || 'unknown error'}`, true);
        }
        if (params.has('gmail')) {
          const url = new URL(location.href);
          url.searchParams.delete('gmail');
          url.searchParams.delete('reason');
          window.history.replaceState({}, '', url.pathname + url.search);
        }
      } catch (error) {}
    }

    const onProfilesChange = (event) => {
      if (dirty && !confirm('Discard unsaved edits to switch persona?')) {
        event.target.value = currentId;
        return;
      }
      currentId = event.target.value;
      fillEditor(selected());
      saveStore();
    };

    const onAddProfile = () => {
      if (dirty && !confirm('Discard unsaved edits and create another persona?')) return;
      const profile = { ...defaultProfile(), name: 'New Agent', company: 'My Company' };
      profiles.push(profile);
      currentId = profile.id;
      saveStore();
      renderProfileList();
      fillEditor(profile);
      $('personaName').focus();
      $('personaName').select();
      showToast('New local persona created.');
    };

    const onDeleteProfile = () => {
      if (profiles.length < 2) return;
      if (!confirm('Delete this locally saved persona?')) return;
      profiles = profiles.filter((profile) => profile.id !== currentId);
      currentId = profiles[0].id;
      saveStore();
      renderProfileList();
      fillEditor(selected());
      showToast('Persona deleted from this browser.');
    };

    const onBackToEditor = () => {
      if (creatingCSR) return;
      if (callState !== 'idle') {
        showToast('End your call before editing the CSR.', true);
        return;
      }
      toggleTray(false);
      mobileDialerOpen = false;
      document.body.classList.remove('mobile-dialer');
      window.scrollTo({ top: 0, behavior: 'instant' });
      $('personaName').focus({ preventScroll: true });
    };

    const mobileQuery = window.matchMedia('(min-width:981px)');
    const onMobileQueryChange = (event) => {
      if (event.matches) {
        document.body.classList.remove('mobile-dialer');
      } else if (mobileDialerOpen) {
        document.body.classList.add('mobile-dialer');
      }
    };

    const onRevertProfile = () => {
      fillEditor(selected());
      showToast('Unsaved edits discarded.');
    };

    const onFieldInput = () => setDirty();

    const onCallClick = () => {
      if (callState === 'connected') stopCall();
      else if (callState === 'idle') startCall();
    };

    const onMuteClick = () => {
      if (callState !== 'connected' || !vapi) return;
      try {
        muted = !muted;
        vapi.setMuted(muted);
        updateMute();
      } catch (error) {
        showToast('Microphone toggle failed.', true);
      }
    };

    const onTranscriptClick = () => toggleTray(true);
    const onCloseTranscriptClick = () => toggleTray(false);

    const onClearTranscript = () => {
      if (callState === 'connected') {
        showToast('End the call before clearing history.', true);
        return;
      }
      transcript = [];
      partial = null;
      renderTranscript();
      showToast('Local transcript cleared.');
    };

    const onBeforeUnload = () => {
      closeRingAudio();
      try {
        if (vapi && callState === 'connected') vapi.stop();
      } catch (error) {}
    };

    const onSignOut = async () => {
      $('signOutBtn').disabled = true;
      closeRingAudio();
      try {
        if (vapi && callState === 'connected') vapi.stop();
      } catch (error) {}
      try {
        await signOut(fbAuth);
      } catch (error) {
        $('signOutBtn').disabled = false;
        showToast('Unable to sign out right now.', true);
        return;
      }
      clearRedirectGuard();
      window.location.replace(AUTH_URL);
    };

    /* ---------- WhatsApp helpers ---------- */
    function waNormalizePhone(value) {
      return (value || '').replace(/[^\d+]/g, '').trim();
    }

    function loadWaSettings() {
      try {
        const data = JSON.parse(localStorage.getItem(WA_SETTINGS_KEY) || 'null');
        if (data && typeof data === 'object') {
          waSettings = {
            autoSend: data.autoSend !== false,
            destination: typeof data.destination === 'string' ? data.destination : ''
          };
        }
      } catch (error) {}
      const auto = $('waAutoSend');
      if (auto) auto.checked = waSettings.autoSend;
      const dest = $('waDestination');
      if (dest) dest.value = waSettings.destination;
    }

    function saveWaSettings() {
      waSettings.autoSend = !!$('waAutoSend')?.checked;
      waSettings.destination = ($('waDestination')?.value || '').trim();
      try {
        localStorage.setItem(WA_SETTINGS_KEY, JSON.stringify(waSettings));
      } catch (error) {}
    }

    function setWaDot(state) {
      const dot = $('waDot');
      if (!dot) return;
      dot.classList.remove('connected', 'connecting', 'off');
      dot.classList.add(state);
    }

    function updateWaUI() {
      const statusText = $('waStatusText');
      const connectBtn = $('waConnect');
      const disconnectBtn = $('waDisconnect');
      const testBtn = $('waTest');
      const note = $('waNote');
      const session = waSession;

      if (!waConfigured) {
        if (statusText) statusText.textContent = 'WhatsApp service not configured';
        setWaDot('off');
        if (connectBtn) connectBtn.textContent = 'Connect WhatsApp';
        if (disconnectBtn) disconnectBtn.hidden = true;
        if (testBtn) testBtn.hidden = true;
        if (note) note.textContent = 'Set WHATSAPP_SERVICE_URL and WHATSAPP_SERVICE_SECRET on the server to enable reports.';
        return;
      }

      if (!waReachable) {
        if (statusText) statusText.textContent = 'WhatsApp service offline';
        setWaDot('off');
        if (connectBtn) {
          connectBtn.hidden = false;
          connectBtn.textContent = 'Retry connection';
          connectBtn.disabled = false;
        }
        if (disconnectBtn) disconnectBtn.hidden = true;
        if (testBtn) testBtn.hidden = true;
        if (note) note.textContent = 'Start the Baileys bridge: docker compose up -d. Then retry.';
        return;
      }

      if (!session) {
        if (statusText) statusText.textContent = 'Not connected';
        setWaDot('off');
        if (connectBtn) connectBtn.textContent = 'Connect WhatsApp';
        if (disconnectBtn) disconnectBtn.hidden = true;
        if (testBtn) testBtn.hidden = true;
        return;
      }

      const status = session.status || 'disconnected';
      if (status === 'connected') {
        const phone = session.phone ? `+${session.phone}` : 'your WhatsApp';
        if (statusText) statusText.textContent = `Connected · ${phone}`;
        setWaDot('connected');
        if (connectBtn) connectBtn.hidden = true;
        if (disconnectBtn) disconnectBtn.hidden = false;
        if (testBtn) testBtn.hidden = false;
      } else if (status === 'awaiting_qr' || status === 'awaiting_code' || status === 'connecting') {
        if (statusText) statusText.textContent = 'Waiting for link…';
        setWaDot('connecting');
        if (connectBtn) {
          connectBtn.hidden = false;
          connectBtn.textContent = 'Connect WhatsApp';
        }
        if (disconnectBtn) disconnectBtn.hidden = true;
        if (testBtn) testBtn.hidden = true;
      } else {
        if (statusText) statusText.textContent = session.lastError || 'Not connected';
        setWaDot('off');
        if (connectBtn) {
          connectBtn.hidden = false;
          connectBtn.textContent = 'Connect WhatsApp';
        }
        if (disconnectBtn) disconnectBtn.hidden = true;
        if (testBtn) testBtn.hidden = true;
      }
    }

    async function waFetchSession() {
      try {
        const token = await fbAuth.currentUser?.getIdToken();
        if (!token) return null;
        const response = await fetch('/api/whatsapp/session', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          waConfigured = response.status !== 503;
          if (response.status === 503) waConfigured = false;
          waReachable = response.status !== 502 && response.status !== 504;
          updateWaUI();
          return null;
        }
        waConfigured = data.configured !== false;
        waReachable = true;
        if (data.session) waSession = data.session;
        updateWaUI();
        return data.session || null;
      } catch (error) {
        waReachable = false;
        updateWaUI();
        return null;
      }
    }

    async function waConnect(method, phone) {
      if (waConnecting) return;
      waConnecting = true;
      const connectBtn = $('waConnect');
      if (connectBtn) connectBtn.disabled = true;
      try {
        const token = await fbAuth.currentUser?.getIdToken();
        if (!token) throw new Error('Your session expired. Please sign in again.');
        const response = await fetch('/api/whatsapp/session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ action: 'connect', method, phone })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          waReachable = response.status !== 502 && response.status !== 504;
          showToast(data?.error || 'Unable to connect WhatsApp.', true);
          updateWaUI();
          return null;
        }
        waConfigured = data.configured !== false;
        waReachable = true;
        if (data.session) waSession = data.session;
        updateWaUI();
        updateWaModal();
        return data.session || null;
      } catch (error) {
        waReachable = false;
        showToast(String(error?.message || error).slice(0, 160), true);
        updateWaUI();
        return null;
      } finally {
        waConnecting = false;
        if (connectBtn) connectBtn.disabled = false;
      }
    }

    async function waDisconnect() {
      try {
        const token = await fbAuth.currentUser?.getIdToken();
        if (!token) return;
        await fetch('/api/whatsapp/session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ action: 'disconnect' })
        });
        await waFetchSession();
      } catch (error) {
        showToast('Unable to disconnect WhatsApp.', true);
      }
    }

    async function waLogout() {
      try {
        const token = await fbAuth.currentUser?.getIdToken();
        if (!token) return;
        await fetch('/api/whatsapp/session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ action: 'logout' })
        });
        waSession = null;
        updateWaUI();
        closeWaModal();
      } catch (error) {
        showToast('Unable to log out of WhatsApp.', true);
      }
    }

    async function sendCallSummary(payload) {
      if (!waSettings.autoSend) return;
      try {
        const token = await fbAuth.currentUser?.getIdToken();
        if (!token) return;
        const response = await fetch('/api/whatsapp/report', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          showToast(data?.error || 'Call ended. WhatsApp summary could not be sent.', true);
          return;
        }
        showToast('Call ended. Summary sent to WhatsApp.');
      } catch (error) {
        showToast('Call ended. WhatsApp summary could not be sent.', true);
      }
    }

    function openWaModal() {
      waModalOpen = true;
      const modal = $('waModal');
      if (!modal) return;
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('wa-modal-open');
      switchWaTab('qr');
      updateWaModal();
      if (!waSession || waSession.status === 'disconnected' || waSession.status === 'error') {
        waConnect('qr', '');
      }
      startWaPolling();
    }

    function closeWaModal() {
      waModalOpen = false;
      const modal = $('waModal');
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('wa-modal-open');
      stopWaPolling();
    }

    function switchWaTab(tab) {
      const qrTab = $('waTabQr');
      const codeTab = $('waTabCode');
      const qrPane = $('waQrPane');
      const codePane = $('waCodePane');
      const isQr = tab === 'qr';
      if (qrTab) {
        qrTab.classList.toggle('active', isQr);
        qrTab.setAttribute('aria-selected', String(isQr));
      }
      if (codeTab) {
        codeTab.classList.toggle('active', !isQr);
        codeTab.setAttribute('aria-selected', String(!isQr));
      }
      if (qrPane) qrPane.hidden = !isQr;
      if (codePane) codePane.hidden = isQr;
    }

    function updateWaModal() {
      const status = $('waModalStatus');
      const qrImage = $('waQrImage');
      const placeholder = $('waQrPlaceholder');
      const codeBox = $('waCodeBox');
      const pairingCode = $('waPairingCode');
      const cancelBtn = $('waCancel');

      const session = waSession;
      if (!session) {
        if (status) status.textContent = waConfigured ? 'Preparing…' : 'WhatsApp service not configured.';
        if (placeholder) placeholder.textContent = waConfigured ? 'Starting…' : 'Not configured';
        if (qrImage) qrImage.hidden = true;
        if (codeBox) codeBox.hidden = true;
        if (cancelBtn) cancelBtn.hidden = true;
        return;
      }

      if (session.status === 'connected') {
        if (status) status.textContent = 'Connected successfully.';
        if (placeholder) placeholder.textContent = 'Connected';
        if (qrImage) qrImage.hidden = true;
        if (codeBox) codeBox.hidden = true;
        if (cancelBtn) cancelBtn.hidden = true;
        window.setTimeout(() => {
          if (waModalOpen) closeWaModal();
        }, 1200);
        return;
      }

      if (session.qr) {
        if (qrImage) {
          qrImage.src = session.qr;
          qrImage.hidden = false;
        }
        if (placeholder) placeholder.hidden = true;
      } else {
        if (qrImage) qrImage.hidden = true;
        if (placeholder) {
          placeholder.hidden = false;
          placeholder.textContent = session.lastError || 'Waiting for QR code…';
        }
      }

      if (session.pairingCode) {
        if (codeBox) codeBox.hidden = false;
        if (pairingCode) {
          const code = session.pairingCode;
          pairingCode.textContent =
            code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        }
      }

      if (status) {
        if (session.status === 'awaiting_qr') status.textContent = 'Scan the QR code with WhatsApp.';
        else if (session.status === 'awaiting_code') status.textContent = 'Enter the code in WhatsApp.';
        else if (session.status === 'connecting') status.textContent = 'Connecting…';
        else if (session.lastError) status.textContent = session.lastError;
        else status.textContent = '';
      }

      const waiting = session.status === 'awaiting_qr' || session.status === 'awaiting_code' || session.status === 'connecting';
      if (cancelBtn) cancelBtn.hidden = !waiting;
    }

    function startWaPolling() {
      stopWaPolling();
      waPollTimer = setInterval(async () => {
        if (!waModalOpen) return;
        await waFetchSession();
        updateWaModal();
        const session = waSession;
        if (session && session.status === 'connected') {
          stopWaPolling();
        }
      }, 2000);
    }

    function stopWaPolling() {
      if (waPollTimer) {
        clearInterval(waPollTimer);
        waPollTimer = null;
      }
    }

    async function initWhatsApp() {
      loadWaSettings();
      await waFetchSession();
    }

    async function gmailFetchStatus() {
      try {
        const token = await fbAuth.currentUser?.getIdToken();
        if (!token) return;
        const response = await fetch('/api/gmail/status', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          gmailConfigured = false;
          updateGmailUI();
          return;
        }
        gmailConfigured = data.configured !== false;
        gmailConnected = !!data.connected;
        gmailEmail = data.email || '';
        updateGmailUI();
      } catch (error) {
        updateGmailUI();
      }
    }

    function updateGmailUI() {
      const statusText = $('gmailStatusText');
      const connectBtn = $('gmailConnect');
      const disconnectBtn = $('gmailDisconnect');
      const dot = $('gmailDot');
      if (dot) {
        dot.classList.remove('connected', 'connecting', 'off');
        dot.classList.add(gmailConnected ? 'connected' : 'off');
      }
      if (!gmailConfigured) {
        if (statusText) statusText.textContent = 'Gmail OAuth not configured';
        if (connectBtn) connectBtn.hidden = true;
        if (disconnectBtn) disconnectBtn.hidden = true;
        return;
      }
      if (gmailConnected) {
        if (statusText) statusText.textContent = `Connected · ${gmailEmail || 'Gmail'}`;
        if (connectBtn) connectBtn.hidden = true;
        if (disconnectBtn) disconnectBtn.hidden = false;
      } else {
        if (statusText) statusText.textContent = 'Not connected';
        if (connectBtn) {
          connectBtn.hidden = false;
          connectBtn.textContent = 'Connect Gmail';
        }
        if (disconnectBtn) disconnectBtn.hidden = true;
      }
    }

    async function gmailConnect() {
      const token = await fbAuth.currentUser?.getIdToken();
      if (!token) {
        showToast('Your session expired. Please sign in again.', true);
        return;
      }
      // Redirect to Google OAuth
      window.location.href = '/api/gmail/auth';
    }

    async function gmailDisconnect() {
      try {
        const token = await fbAuth.currentUser?.getIdToken();
        if (!token) return;
        await fetch('/api/gmail/disconnect', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        });
        gmailConnected = false;
        gmailEmail = '';
        updateGmailUI();
        showToast('Gmail disconnected.');
      } catch (error) {
        showToast('Unable to disconnect Gmail.', true);
      }
    }

    $('profiles').addEventListener('change', onProfilesChange);
    $('addProfile').addEventListener('click', onAddProfile);
    $('deleteProfile').addEventListener('click', onDeleteProfile);
    $('saveProfile').addEventListener('click', savePersona);
    $('backToEditor').addEventListener('click', onBackToEditor);
    mobileQuery.addEventListener('change', onMobileQueryChange);
    $('revertProfile').addEventListener('click', onRevertProfile);
    ['personaName', 'companyName', 'websiteUrl', 'voiceSelect', 'languageSelect', 'firstMessage'].forEach(
      (id) => $(id).addEventListener('input', onFieldInput)
    );
    $('callBtn').addEventListener('click', onCallClick);
    $('muteBtn').addEventListener('click', onMuteClick);
    $('transcriptBtn').addEventListener('click', onTranscriptClick);
    $('closeTranscript').addEventListener('click', onCloseTranscriptClick);
    $('downloadTranscript').addEventListener('click', downloadTranscript);
    $('clearTranscript').addEventListener('click', onClearTranscript);
    $('signOutBtn').addEventListener('click', onSignOut);
    $('waConnect')?.addEventListener('click', () => openWaModal());
    $('waDisconnect')?.addEventListener('click', () => waLogout());
    $('waTest')?.addEventListener('click', async () => {
      try {
        const token = await fbAuth.currentUser?.getIdToken();
        if (!token) return;
        const response = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            text: '*CSR Studio test message*\\nYour WhatsApp reports are connected. Call summaries will arrive here after each call.',
            to: waSettings.destination
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          showToast(data?.error || 'Test message failed.', true);
          return;
        }
        showToast('Test message sent to WhatsApp.');
      } catch (error) {
        showToast('Test message failed.', true);
      }
    });
    $('waAutoSend')?.addEventListener('change', saveWaSettings);
    $('waDestination')?.addEventListener('change', saveWaSettings);
    $('waModalClose')?.addEventListener('click', closeWaModal);
    $('waCancel')?.addEventListener('click', async () => {
      if (waSession && (waSession.status === 'awaiting_qr' || waSession.status === 'awaiting_code' || waSession.status === 'connecting')) {
        await waDisconnect();
      }
      closeWaModal();
    });
    document.querySelectorAll('[data-wa-close="true"]').forEach((el) =>
      el.addEventListener('click', closeWaModal)
    );
    $('waTabQr')?.addEventListener('click', () => switchWaTab('qr'));
    $('waTabCode')?.addEventListener('click', () => switchWaTab('code'));

    $('gmailConnect')?.addEventListener('click', () => gmailConnect());
    $('gmailDisconnect')?.addEventListener('click', () => gmailDisconnect());
    $('waGetCode')?.addEventListener('click', async () => {
      const phone = ($('waPhone')?.value || '').trim();
      const btn = $('waGetCode');
      if (btn) btn.disabled = true;
      await waConnect('code', phone);
      if (btn) btn.disabled = false;
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && waModalOpen) closeWaModal();
    });
    window.addEventListener('beforeunload', onBeforeUnload);

    const unsubscribe = onAuthStateChanged(fbAuth, (user) => {
      if (disposed) return;
      if (user) {
        if (authGraceTimer) {
          clearTimeout(authGraceTimer);
          authGraceTimer = null;
        }
        clearRedirectGuard();
        initStudio();
        /* Reveal the app immediately; the profile chip can fill in afterwards. */
        $('authGate').classList.add('hidden');
        renderSignedInUser(user).catch(() => {});
        return;
      }
      /* Give Firebase a moment to restore a persisted session before bouncing. */
      if (authGraceTimer) return;
      authGraceTimer = setTimeout(() => {
        authGraceTimer = null;
        if (disposed) return;
        if (fbAuth.currentUser) return;
        goToAuth();
      }, 1500);
    });

    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(interval);
      clearInterval(clockInterval);
      clearTimeout(toastTimer);
      if (authGraceTimer) clearTimeout(authGraceTimer);
      stopWaPolling();
      document.body.classList.remove('wa-modal-open');
      closeRingAudio();
      try {
        if (vapi && callState === 'connected') vapi.stop();
      } catch (error) {}
      $('profiles')?.removeEventListener('change', onProfilesChange);
      $('addProfile')?.removeEventListener('click', onAddProfile);
      $('deleteProfile')?.removeEventListener('click', onDeleteProfile);
      $('saveProfile')?.removeEventListener('click', savePersona);
      $('backToEditor')?.removeEventListener('click', onBackToEditor);
      mobileQuery.removeEventListener('change', onMobileQueryChange);
      $('revertProfile')?.removeEventListener('click', onRevertProfile);
      [
        'personaName',
        'companyName',
        'websiteUrl',
        'voiceSelect',
        'languageSelect',
        'firstMessage'
      ].forEach((id) => $(id)?.removeEventListener('input', onFieldInput));
      $('callBtn')?.removeEventListener('click', onCallClick);
      $('muteBtn')?.removeEventListener('click', onMuteClick);
      $('transcriptBtn')?.removeEventListener('click', onTranscriptClick);
      $('closeTranscript')?.removeEventListener('click', onCloseTranscriptClick);
      $('downloadTranscript')?.removeEventListener('click', downloadTranscript);
      $('clearTranscript')?.removeEventListener('click', onClearTranscript);
      $('signOutBtn')?.removeEventListener('click', onSignOut);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.body.classList.remove('mobile-dialer');
    };
  }, [firebaseConfig, vapiConfig]);

  return (
    <>
      <div className="bg-canvas" aria-hidden="true">
        <div className="bg-orb orb-1" />
        <div className="bg-orb orb-2" />
        <svg className="bg-waves" viewBox="0 0 1440 900" preserveAspectRatio="none">
          <defs>
            <linearGradient id="iw1" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#72dfbf" stopOpacity="0.16" />
              <stop offset="55%" stopColor="#5876ff" stopOpacity="0.10" />
              <stop offset="100%" stopColor="#9e87ff" stopOpacity="0.04" />
            </linearGradient>
            <linearGradient id="iw2" x1="1" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6ee7c8" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#283d8a" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <path
            fill="url(#iw1)"
            d="M0,560 C240,455 440,670 720,575 C1000,480 1210,355 1440,445 L1440,900 L0,900 Z"
          />
          <path
            fill="url(#iw2)"
            d="M0,695 C320,765 560,550 860,645 C1140,730 1290,590 1440,635 L1440,900 L0,900 Z"
          />
          <path
            fill="none"
            stroke="#72dfbf"
            strokeOpacity="0.15"
            strokeWidth="1.5"
            d="M0,560 C240,455 440,670 720,575 C1000,480 1210,355 1440,445"
          />
          <path
            fill="none"
            stroke="#8ea2ff"
            strokeOpacity="0.12"
            strokeWidth="1.5"
            d="M0,695 C320,765 560,550 860,645 C1140,730 1290,590 1440,635"
          />
        </svg>
      </div>

      <div
        className="auth-gate"
        id="authGate"
        role="status"
        aria-live="polite"
        aria-label="Verifying session"
      >
        <div className="gate-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <path d="M3 12h3l2-6 4 12 3-9 2 3h4" />
          </svg>
        </div>
        <div className="gate-loader" aria-hidden="true" />
      </div>

      <div className="app">
        <header className="topbar">
          <div className="brand">
            <div className="brand-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <path d="M3 12h3l2-6 4 12 3-9 2 3h4" />
              </svg>
            </div>
            <span>
              Persona <span style={{ color: 'var(--mint)' }}>Studio</span>
            </span>
          </div>
          <div className="user-bar" id="userBar">
            <div className="user-chip">
              <span className="user-avatar" id="userAvatar">
                U
              </span>
              <span className="user-name" id="userName">
                Account
              </span>
            </div>
            <button
              className="signout-btn"
              id="signOutBtn"
              type="button"
              title="Sign out"
              aria-label="Sign out"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
              <span>Sign out</span>
            </button>
          </div>
        </header>

        <main className="workspace">
          <section className="editor" aria-labelledby="persona-heading">
            <div className="editor-top">
              <div className="title-row">
                <div className="section-mark">
                  <span className="section-icon" aria-hidden="true">
                    <svg
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth="1.7"
                    >
                      <circle cx="12" cy="7.5" r="3.5" />
                      <path d="M5.5 20c.2-4.2 2.5-6.3 6.5-6.3s6.3 2.1 6.5 6.3M19 4v5M16.5 6.5h5" />
                    </svg>
                  </span>
                  <div>
                    <div className="section-title" id="persona-heading">
                      Configure CSR
                    </div>
                  </div>
                </div>
              </div>
              <div className="profile-row">
                <div className="field">
                  <label htmlFor="profiles" className="field-label">
                    Saved personas
                  </label>
                  <select id="profiles" aria-label="Select saved persona" />
                </div>
                <button
                  className="tiny-btn"
                  id="addProfile"
                  title="Add CSR"
                  aria-label="Add CSR"
                  type="button"
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                <button
                  className="tiny-btn danger"
                  id="deleteProfile"
                  title="Delete selected saved persona"
                  aria-label="Delete persona"
                  type="button"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M4 7h16M10 3h4M6 7l1 13h10l1-13M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="form-body">
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="personaName">CSR name</label>
                  <input
                    id="personaName"
                    maxLength="60"
                    autoComplete="off"
                    placeholder="e.g. Alex"
                    defaultValue="Alex"
                  />
                </div>
                <div className="field">
                  <label htmlFor="companyName">Company</label>
                  <input
                    id="companyName"
                    maxLength="100"
                    autoComplete="organization"
                    placeholder="e.g. TechSolutions"
                    defaultValue="TechSolutions"
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="websiteUrl">Company website URL</label>
                <input
                  id="websiteUrl"
                  type="url"
                  inputMode="url"
                  maxLength="250"
                  autoComplete="url"
                  placeholder="https://www.abitech.site/"
                />
              </div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="voiceSelect">Voice</label>
                  <select id="voiceSelect">
                    <option value="Elliot">Elliot — male · calm</option>
                    <option value="Emma">Emma — female · friendly</option>
                    <option value="Clara">Clara — female · professional</option>
                    <option value="Kai">Kai — male · helpful</option>
                    <option value="Godfrey">Godfrey — male · professional</option>
                    <option value="Sid">Sid — male · calm</option>
                    <option value="Savannah">Savannah — female · conversational</option>
                    <option value="Layla">Layla — female · natural</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="languageSelect">Main language</label>
                  <select id="languageSelect" />
                </div>
              </div>
              <div className="field">
                <label htmlFor="firstMessage">Agent first message</label>
                <textarea
                  id="firstMessage"
                  spellCheck="false"
                  aria-label="Agent first message"
                  placeholder="Hey there, thanks for calling {{company}}, this is {{persona}}. Who am I speaking with today, and what can I help you with?"
                />
              </div>
              <div>
                <div className="actions">
                  <button className="outline-btn" id="revertProfile" type="button">
                    Discard
                  </button>
                  <button className="primary-btn" id="saveProfile" type="button">
                    <span>Create CSR</span>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12h14m-6-6 6 6-6 6" />
                    </svg>
                  </button>
                </div>
                <div className="save-status" id="saveStatus" aria-live="polite" />
              </div>

              <section className="wa-card" aria-labelledby="waHeading">
                <div className="wa-head">
                  <span className="wa-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
                    </svg>
                  </span>
                  <div className="wa-head-text">
                    <div className="wa-title" id="waHeading">
                      WhatsApp call reports
                    </div>
                    <div className="wa-sub" id="waStatusText">
                      Checking connection…
                    </div>
                  </div>
                  <span className="wa-dot" id="waDot" aria-hidden="true" />
                </div>

                <label className="wa-toggle">
                  <input type="checkbox" id="waAutoSend" defaultChecked />
                  <span>Send a summary after every call</span>
                </label>

                <div className="wa-field">
                  <label htmlFor="waDestination">
                    Destination number <span className="wa-optional">(optional)</span>
                  </label>
                  <input
                    id="waDestination"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="Leave blank to message yourself"
                  />
                </div>

                <div className="wa-actions">
                  <button className="wa-btn" id="waConnect" type="button">
                    Connect WhatsApp
                  </button>
                  <button className="wa-btn ghost" id="waDisconnect" type="button" hidden>
                    Disconnect
                  </button>
                  <button className="wa-btn ghost" id="waTest" type="button" hidden>
                    Send test
                  </button>
                </div>
                <p className="wa-note" id="waNote">
                  After each finished call, the agent sends a transcript summary to your WhatsApp.
                  Nothing is shared with third parties.
                </p>
              </section>

              <section className="wa-card" aria-labelledby="gmailHeading">
                <div className="wa-head">
                  <span className="wa-icon" aria-hidden="true" style={{ background: '#2a2a3a', color: '#ea4335' }}>
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" />
                    </svg>
                  </span>
                  <div className="wa-head-text">
                    <div className="wa-title" id="gmailHeading">Gmail integration</div>
                    <div className="wa-sub" id="gmailStatusText">Checking connection…</div>
                  </div>
                  <span className="wa-dot" id="gmailDot" aria-hidden="true" />
                </div>

                <p className="wa-note" id="gmailNote">
                  Connect your Gmail so the voice agent can read, search, send, and manage your emails during calls.
                  Uses Google OAuth — you stay in control.
                </p>

                <div className="wa-actions">
                  <button className="wa-btn" id="gmailConnect" type="button">
                    Connect Gmail
                  </button>
                  <button className="wa-btn ghost" id="gmailDisconnect" type="button" hidden>
                    Disconnect
                  </button>
                </div>
              </section>
            </div>
          </section>

          <section className="preview" aria-label="Voice calling interface">
            <div className="mobile-dialer-header" id="mobileDialerHeader">
              <button
                className="edit-csr-btn"
                id="backToEditor"
                type="button"
                aria-label="Edit CSR persona"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m15 18-6-6 6-6" />
                </svg>
                <span>Edit CSR</span>
              </button>
              <div className="mobile-dialer-heading">
                <strong id="mobileAgentName">Alex</strong>
                <small id="mobileAgentCompany">TechSolutions</small>
              </div>
              <span className="mobile-dialer-signal">
                <i />
                <span>AI VOICE</span>
              </span>
            </div>
            <div className="preview-kicker">Live dialer</div>
            <div className="phone" aria-label="Web voice dialer">
              <div className="island" aria-hidden="true" />
              <div className="status-strip">
                <span id="phoneClock">9:41</span>
                <div className="status-icons" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="currentColor">
                    <path d="M1 13h3v5H1zm5-4h3v9H6zm5-4h3v13h-3zm5-3h3v16h-3z" />
                  </svg>
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <rect x="1.5" y="4" width="16" height="12" rx="3" />
                    <path d="M19 8v4" />
                  </svg>
                </div>
              </div>
              <div className="call-screen">
                <div className="avatar-wrap">
                  <div className="avatar-glow" id="avatarGlow" />
                  <div className="avatar" id="avatar" aria-hidden="true">
                    A
                  </div>
                </div>
                <div className="phone-name" id="phoneName">
                  Alex
                </div>
                <div className="phone-company" id="phoneCompany">
                  TechSolutions
                </div>
                <div className="call-state" id="callState">
                  <span className="live" />
                  <span id="callStatusText" role="status" aria-live="polite">
                    Ready to connect
                  </span>
                </div>
                <div className="timer" id="callDuration">
                  00:00
                </div>
                <div
                  className="audio-visual"
                  id="audioVisualizer"
                  aria-label="Voice activity indicator"
                >
                  {Array.from({ length: 21 }).map((_, index) => (
                    <i key={index} />
                  ))}
                </div>
                <div className="call-controls">
                  <div className="ctrl-wrap">
                    <button
                      className="control"
                      id="muteBtn"
                      aria-label="Mute microphone"
                      title="Mute microphone"
                      disabled
                      type="button"
                    >
                      <svg
                        id="muteIcon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="2" width="6" height="12" rx="3" />
                        <path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" />
                      </svg>
                    </button>
                    <span id="muteLabel">Mute</span>
                  </div>
                  <div className="ctrl-wrap">
                    <button
                      className="control call"
                      id="callBtn"
                      aria-label="Start a web voice call"
                      title="Start call"
                      type="button"
                    >
                      <svg
                        id="callIcon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M22 16.8V20a2 2 0 0 1-2.2 2A18.8 18.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3.2a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 1.9L7.6 10A15 15 0 0 0 14 16.4l1.4-1.5a2 2 0 0 1 1.9-.6l3 .5a2 2 0 0 1 1.7 2z" />
                      </svg>
                    </button>
                    <span id="callBtnLabel">Call</span>
                  </div>
                  <div className="ctrl-wrap">
                    <button
                      className="control"
                      id="transcriptBtn"
                      aria-label="Show transcript"
                      title="Show transcript"
                      type="button"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M4 4h16v12H9l-5 4V4zM8 9h8M8 12h6" />
                      </svg>
                    </button>
                    <span>Transcript</span>
                  </div>
                </div>
              </div>
              <div className="transcript-tray" id="transcriptTray" aria-hidden="true">
                <div className="tray-top">
                  <span>Conversation transcript</span>
                  <button
                    className="tray-close"
                    id="closeTranscript"
                    aria-label="Close transcript"
                    type="button"
                  >
                    ×
                  </button>
                </div>
                <div className="transcript-content" id="transcriptContent">
                  <div className="empty-transcript">
                    Your conversation will appear here when the call starts.
                  </div>
                </div>
                <div className="tray-footer">
                  <button id="downloadTranscript" type="button">
                    Download transcript
                  </button>
                  <button id="clearTranscript" type="button">
                    Clear history
                  </button>
                </div>
              </div>
              <div className="home-indicator" aria-hidden="true" />
            </div>
            <div className="phone-bottom" aria-live="polite">
              <strong id="phoneFooter">Ready</strong>
            </div>
          </section>
        </main>
      </div>
      <div
        className="wa-modal"
        id="waModal"
        aria-hidden="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="waModalTitle"
      >
        <div className="wa-modal-backdrop" data-wa-close="true" />
        <div className="wa-modal-card">
          <button
            className="wa-modal-close"
            id="waModalClose"
            type="button"
            aria-label="Close"
          >
            ×
          </button>
          <h2 id="waModalTitle">Connect your WhatsApp</h2>
          <p className="wa-modal-desc">
            Scan the QR code with WhatsApp on your phone, or link your number with a code.
          </p>

          <div className="wa-tabs" role="tablist">
            <button
              className="wa-tab active"
              id="waTabQr"
              type="button"
              role="tab"
              aria-selected="true"
            >
              QR code
            </button>
            <button
              className="wa-tab"
              id="waTabCode"
              type="button"
              role="tab"
              aria-selected="false"
            >
              Phone code
            </button>
          </div>

          <div className="wa-pane" id="waQrPane">
            <div className="wa-qr-box">
              <img id="waQrImage" alt="WhatsApp QR code" hidden />
              <div className="wa-qr-placeholder" id="waQrPlaceholder">
                Starting…
              </div>
            </div>
            <ol className="wa-steps">
              <li>Open WhatsApp on your phone.</li>
              <li>
                Tap <strong>Settings → Linked devices → Link a device</strong>.
              </li>
              <li>Point your phone at this screen to scan the code.</li>
            </ol>
          </div>

          <div className="wa-pane" id="waCodePane" hidden>
            <div className="wa-field">
              <label htmlFor="waPhone">WhatsApp number</label>
              <input
                id="waPhone"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+1 555 000 0000"
              />
            </div>
            <button className="wa-btn" id="waGetCode" type="button">
              Get link code
            </button>
            <div className="wa-code-box" id="waCodeBox" hidden>
              <span>Enter this code in WhatsApp → Linked devices → Link with phone number</span>
              <strong id="waPairingCode">----</strong>
            </div>
          </div>

          <div className="wa-modal-status" id="waModalStatus" aria-live="polite" />
          <button className="wa-btn ghost" id="waCancel" type="button" hidden>
            Cancel
          </button>
        </div>
      </div>

      <div className="toast" id="toast" role="status" aria-live="polite" />
      <div
        className="create-overlay"
        id="createOverlay"
        aria-hidden="true"
        role="status"
        aria-live="polite"
      >
        <div className="create-progress-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 12h3l2-6 4 12 3-9 2 3h4" />
          </svg>
        </div>
        <div className="create-loader" aria-hidden="true" />
        <h2>Creating CSR…</h2>
      </div>
    </>
  );
}
