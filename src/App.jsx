import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock3,
  Download,
  ChevronDown,
  ChevronUp,
  FileVideo,
  Film,
  Flag,
  Loader2,
  Play,
  Radio,
  RotateCcw,
  Upload,
  Video,
} from "lucide-react";
import { apiFetch, backendBaseUrl, clipPlaybackUrl, clipThumbnailUrl, isRemoteBackend, openJobEventSource, uploadMatchVideo } from "./apiClient";
import { PitchClipersPixelLogo } from "./components/PitchClipersPixelLogo";
import { EVENT_TYPES, buildClipCandidates, filterAndSortEvents } from "./eventProcessing";
import { runFixtureProcessing } from "./fixtureAdapter";

const allowedExtensions = [".mp4", ".mov", ".avi", ".mkv", ".m4v", ".webm"];

function formatTime(seconds = 0) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const hh = Math.floor(safe / 3600);
  const mm = Math.floor((safe % 3600) / 60);
  const ss = safe % 60;
  return [hh, mm, ss].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function validateVideo(file) {
  if (!file) return "Choose a video file first.";
  const ext = `.${file.name.split(".").pop()?.toLowerCase() || ""}`;
  if (!file.type.startsWith("video/") && !allowedExtensions.includes(ext)) {
    return `Unsupported file type. Use ${allowedExtensions.join(", ")} or another video MIME type.`;
  }
  if (!file.size) return "The selected file is empty.";
  return "";
}

function normalizePercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function eventColor(id, eventTypes) {
  return eventTypes.find((item) => item.id === id)?.color || "#64748b";
}

function parseSsePayload(event) {
  if (!event?.data) return {};
  try {
    return JSON.parse(event.data);
  } catch {
    return { message: event.data };
  }
}

function App() {
  const appMode = import.meta.env.VITE_APP_MODE || "fixture";
  const isFixtureMode = appMode !== "api";
  const [eventTypes] = useState(EVENT_TYPES);
  const [selectedTypes, setSelectedTypes] = useState(new Set(EVENT_TYPES.map((event) => event.id)));
  const [selectedFile, setSelectedFile] = useState(null);
  const [localVideoUrl, setLocalVideoUrl] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);
  const [fileError, setFileError] = useState("");
  const [matchName, setMatchName] = useState("Untitled match");
  const [teamA, setTeamA] = useState("");
  const [teamB, setTeamB] = useState("");
  const [half, setHalf] = useState("");
  const [match, setMatch] = useState(null);
  const [job, setJob] = useState(null);
  const [clips, setClips] = useState([]);
  const [events, setEvents] = useState([]);
  const [threshold, setThreshold] = useState(0.5);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [selectedClipIds, setSelectedClipIds] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [uploadState, setUploadState] = useState("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [processingState, setProcessingState] = useState("idle");
  const [processingProgress, setProcessingProgress] = useState(null);
  const [processingLabel, setProcessingLabel] = useState("Waiting for video");
  const [connectionMode, setConnectionMode] = useState("idle");
  const [activityLog, setActivityLog] = useState([]);
  const [message, setMessage] = useState("");
  const sseRef = useRef(null);
  const pollRef = useRef(null);
  const videoRef = useRef(null);

  const selectedTypeList = useMemo(() => Array.from(selectedTypes), [selectedTypes]);
  const readyClips = clips.filter((clip) => clip.status === "ready");
  const visibleEvents = useMemo(
    () => filterAndSortEvents(events, { selectedTypeIds: selectedTypeList, threshold }),
    [events, selectedTypeList, threshold],
  );
  const fixtureClips = useMemo(() => buildClipCandidates(visibleEvents, videoDuration || match?.duration_sec || 5400), [visibleEvents, videoDuration, match]);
  const displayClips = isFixtureMode ? fixtureClips : clips;
  const selectedEvent = visibleEvents.find((event) => event.event_id === selectedEventId) || null;
  const selectedClips = selectedClipIds.map((id) => displayClips.find((clip) => clip.clip_id === id)).filter(Boolean);
  const displayDuration = videoDuration || match?.duration_sec || 5400;
  const backendLabel = isFixtureMode ? "local fixture adapter" : isRemoteBackend ? backendBaseUrl : "local Vite proxy -> 127.0.0.1:8000";
  const canStart = Boolean(selectedFile && !fileError && selectedTypeList.length && (!isFixtureMode || videoDuration));

  useEffect(() => {
    setSelectedClipIds((previous) => previous.filter((id) => displayClips.some((clip) => clip.clip_id === id)));
  }, [displayClips]);

  useEffect(() => {
    return () => {
      if (localVideoUrl) URL.revokeObjectURL(localVideoUrl);
    };
  }, [localVideoUrl]);

  useEffect(() => {
    return () => {
      closeSse();
      stopPolling();
    };
  }, []);

  function closeSse() {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
  }

  function stopPolling() {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function appendLog(type, payload = {}) {
    const label = payload.message || payload.stage || payload.clip_id || payload.status || type;
    setActivityLog((previous) => [{ id: `${Date.now()}-${type}`, type, label, payload }, ...previous].slice(0, 12));
  }

  function mergeClips(incomingClips = []) {
    if (!incomingClips.length) return;
    setClips((previous) => {
      const byId = new Map(previous.map((clip) => [clip.clip_id, clip]));
      incomingClips.forEach((clip) => {
        if (clip?.clip_id) byId.set(clip.clip_id, { ...byId.get(clip.clip_id), ...clip });
      });
      return Array.from(byId.values()).sort((a, b) => Number(a.start_sec || 0) - Number(b.start_sec || 0));
    });
  }

  function updateProcessingProgress(payload = {}, fallback = null) {
    const progress = normalizePercent(payload.progress_percent ?? payload.progress);
    if (progress !== null) setProcessingProgress(progress);
    else if (fallback !== null) setProcessingProgress(fallback);
  }

  async function pollClips(matchId) {
    try {
      const data = await apiFetch(`/api/matches/${matchId}/clips`);
      const nextClips = Array.isArray(data) ? data : data.clips || [];
      mergeClips(nextClips);
      if (!Array.isArray(data) && Array.isArray(data.events)) setEvents(data.events);
    } catch (error) {
      appendLog("polling_error", { message: error.message });
    }
  }

  function startPolling(matchId) {
    if (!matchId || pollRef.current) return;
    setConnectionMode("polling");
    pollClips(matchId);
    pollRef.current = window.setInterval(() => pollClips(matchId), 2500);
  }

  function handleSseEvent(type, event, activeMatchId) {
    const payload = parseSsePayload(event);
    appendLog(type, payload);

    if (type === "job_started") {
      setProcessingState("processing");
      setProcessingLabel("Processing started");
      updateProcessingProgress(payload, 5);
    }

    if (type === "upload_received") {
      setProcessingLabel("Upload received by backend");
      updateProcessingProgress(payload, 10);
    }

    if (type === "window_started") {
      setProcessingLabel("Analyzing video window");
      updateProcessingProgress(payload);
    }

    if (type === "window_completed") {
      setProcessingLabel("Window completed");
      updateProcessingProgress(payload);
    }

    if (type === "clip_ready") {
      const clip = payload.clip || payload;
      mergeClips([{ ...clip, status: clip.status || "ready", match_id: clip.match_id || activeMatchId }]);
      if (payload.event) setEvents((previous) => [...previous, payload.event]);
      setProcessingLabel("Clip ready");
      updateProcessingProgress(payload);
    }

    if (type === "job_completed") {
      setProcessingState("completed");
      setProcessingLabel("Job completed");
      setProcessingProgress(100);
      stopPolling();
      closeSse();
    }

    if (type === "error") {
      setProcessingState("failed");
      setProcessingLabel("Backend error");
      setMessage(payload.message || "The backend reported an error.");
    }
  }

  function openSse(streamUrl, jobId, activeMatchId) {
    if (!streamUrl && !jobId) return false;
    if (!window.EventSource) return false;

    closeSse();
    const source = openJobEventSource(streamUrl, jobId);
    sseRef.current = source;
    setConnectionMode("sse");

    ["job_started", "upload_received", "window_started", "window_completed", "clip_ready", "job_completed", "error"].forEach((type) => {
      source.addEventListener(type, (event) => handleSseEvent(type, event, activeMatchId));
    });

    source.onerror = () => {
      appendLog("sse_disconnected", { message: "SSE disconnected; polling fallback enabled." });
      closeSse();
      startPolling(activeMatchId);
    };

    return true;
  }

  function resetWorkflow() {
    closeSse();
    stopPolling();
    setMatch(null);
    setJob(null);
    setClips([]);
    setEvents([]);
    setSelectedEventId(null);
    setSelectedClipIds([]);
    setCurrentTime(0);
    setVideoDuration(0);
    setUploadState("idle");
    setUploadProgress(0);
    setProcessingState("idle");
    setProcessingProgress(null);
    setProcessingLabel("Waiting for video");
    setConnectionMode("idle");
    setActivityLog([]);
    setMessage("");
  }

  function handleFile(file) {
    const error = validateVideo(file);
    resetWorkflow();
    setSelectedFile(file || null);
    setFileError(error);
    if (localVideoUrl) URL.revokeObjectURL(localVideoUrl);
    setLocalVideoUrl(error || !file ? "" : URL.createObjectURL(file));
  }

  function toggleEventType(id) {
    setSelectedTypes((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function seekToTime(seconds) {
    const safeTime = Math.max(0, Math.min(displayDuration, Number(seconds) || 0));
    if (videoRef.current) videoRef.current.currentTime = safeTime;
    setCurrentTime(safeTime);
  }

  function selectEvent(event) {
    setSelectedEventId(event.event_id);
    seekToTime(event.timestamp_sec);
  }

  function selectClip(clip) {
    const event = visibleEvents.find((item) => clip.event_ids?.includes(item.event_id));
    if (event) setSelectedEventId(event.event_id);
    seekToTime(clip.start_sec);
  }

  function toggleClipSelection(clipId) {
    setSelectedClipIds((previous) => (previous.includes(clipId) ? previous.filter((id) => id !== clipId) : [...previous, clipId]));
  }

  function moveClip(clipId, direction) {
    setSelectedClipIds((previous) => {
      const index = previous.indexOf(clipId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function downloadText(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportManifest(format) {
    const exportClips = selectedClips.length ? selectedClips : displayClips;
    const exportEvents = visibleEvents.filter((event) => exportClips.some((clip) => clip.event_ids?.includes(event.event_id)));
    if (format === "json") {
      downloadText(
        "pitchclipers-events.json",
        JSON.stringify({ schema_version: "1.0", source: isFixtureMode ? "fixture" : "api", duration_sec: displayDuration, events: exportEvents, clips: exportClips }, null, 2),
        "application/json",
      );
      return;
    }
    const rows = ["event_id,class_id,label,timestamp_sec,confidence,clip_start_sec,clip_end_sec"];
    exportEvents.forEach((event) => {
      const clip = exportClips.find((item) => item.event_ids?.includes(event.event_id));
      rows.push([event.event_id, event.class_id, event.label, event.timestamp_sec.toFixed(2), event.confidence.toFixed(3), clip?.start_sec?.toFixed(2) || "", clip?.end_sec?.toFixed(2) || ""].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","));
    });
    downloadText("pitchclipers-events.csv", `${rows.join("\n")}\n`, "text/csv;charset=utf-8");
  }

  async function startFixtureWorkflow() {
    const error = validateVideo(selectedFile);
    setFileError(error);
    if (error) return;

    setMatch({ match_id: "local-demo", duration_sec: displayDuration, metadata: { match_name: matchName.trim() || selectedFile.name } });
    setJob({ job_id: "fixture-job", status: "processing" });
    setClips([]);
    setEvents([]);
    setSelectedClipIds([]);
    setUploadState("uploading");
    setProcessingState("processing");
    setProcessingProgress(0);
    setProcessingLabel("Preparing local fixture");
    setConnectionMode("fixture");
    setActivityLog([]);
    setMessage("Fixture mode uses deterministic demo events; no video leaves this browser.");

    try {
      const result = await runFixtureProcessing({
        durationSec: displayDuration,
        selectedTypeIds: selectedTypeList,
        onProgress: (progress, label) => {
          setUploadProgress(progress < 20 ? progress * 5 : 100);
          setProcessingProgress(progress);
          setProcessingLabel(label);
        },
        onEvent: (event) => setEvents((previous) => [...previous, event]),
        onLog: (entry) => appendLog(entry.type, entry),
      });
      setEvents(result.events);
      setProcessingState("completed");
      setProcessingLabel("Fixture processing complete");
      setUploadState("uploaded");
      setUploadProgress(100);
      setProcessingProgress(100);
      setJob({ job_id: "fixture-job", status: "completed" });
    } catch (fixtureError) {
      setProcessingState("failed");
      setUploadState("failed");
      setProcessingLabel("Fixture failed");
      setMessage(fixtureError.message);
    }
  }

  async function startBackendWorkflow() {
    const error = validateVideo(selectedFile);
    setFileError(error);
    setMessage("");
    if (error) return;

    closeSse();
    stopPolling();
    setClips([]);
    setEvents([]);
    setSelectedClipIds([]);
    setActivityLog([]);
    setUploadProgress(0);
    setProcessingProgress(null);
    setUploadState("initiating");
    setProcessingState("idle");
    setProcessingLabel("Creating match job");

    try {
      const metadata = {
        match_name: matchName.trim() || selectedFile.name,
        teams: [teamA.trim(), teamB.trim()].filter(Boolean),
        half: half ? Number(half) : null,
      };
      const initiateResponse = await apiFetch("/api/matches/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: selectedFile.name,
          content_type: selectedFile.type || "application/octet-stream",
          size_bytes: selectedFile.size,
          selected_event_types: selectedTypeList,
          metadata,
        }),
      });

      const activeMatch = { ...initiateResponse, metadata };
      setMatch(activeMatch);
      appendLog("match_initiated", { match_id: initiateResponse.match_id });
      if (initiateResponse.stream_url) openSse(initiateResponse.stream_url, null, initiateResponse.match_id);

      setUploadState("uploading");
      await uploadMatchVideo({
        matchId: initiateResponse.match_id,
        file: selectedFile,
        uploadUrl: initiateResponse.upload_url,
        onProgress: setUploadProgress,
      });
      setUploadState("uploaded");
      setUploadProgress(100);
      setProcessingState("starting");
      setProcessingLabel("Starting processing");

      const processResponse = await apiFetch(`/api/matches/${initiateResponse.match_id}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected_event_types: selectedTypeList }),
      });

      setJob(processResponse);
      if (Array.isArray(processResponse.events)) setEvents(processResponse.events);
      setProcessingState(processResponse.status || "queued");
      setProcessingLabel(processResponse.status === "processing" ? "Processing" : "Queued");
      setProcessingProgress((current) => current ?? 5);
      appendLog("process_started", processResponse);

      const sseOpened =
        Boolean(initiateResponse.stream_url) ||
        openSse(processResponse.stream_url, processResponse.job_id, initiateResponse.match_id);
      if (!sseOpened) startPolling(initiateResponse.match_id);
    } catch (error) {
      setMessage(error.message);
      setUploadState((state) => (state === "uploading" || state === "initiating" ? "failed" : state));
      setProcessingState("failed");
      setProcessingLabel("Failed");
    }
  }

  function startWorkflow() {
    if (isFixtureMode) return startFixtureWorkflow();
    return startBackendWorkflow();
  }

  const progressStyle = processingProgress === null ? "progress-fill indeterminate" : "progress-fill";

  return (
    <div className="app-shell">
      <aside className="side-rail" aria-label="Primary">
        <div className="brand-mark">
          <PitchClipersPixelLogo compact className="rail-logo" />
        </div>
        <nav className="rail-nav">
          <button className="rail-item active" aria-label="Upload">
            <Video size={19} />
          </button>
          <button className="rail-item" aria-label="Processing">
            <Radio size={19} />
          </button>
          <button className="rail-item" aria-label="Clips">
            <Film size={19} />
          </button>
          <button className="rail-item" aria-label="Events">
            <Flag size={19} />
          </button>
        </nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <PitchClipersPixelLogo compact className="topbar-logo" />
            <div>
              <h1>Football Highlight Studio</h1>
              <p>{isFixtureMode ? "Local fixture workflow for event spotting and clip review." : "Original upload, backend windowing, model inference, and incremental clip delivery."}</p>
            </div>
          </div>
          <div className={`status-pill ${processingState === "completed" ? "ready" : ""}`}>
            {processingState === "processing" || processingState === "queued" || processingState === "starting" ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}
            {isFixtureMode ? "Local fixture mode" : connectionMode === "sse" ? "SSE connected" : connectionMode === "polling" ? "Polling fallback" : "Backend ready"}
          </div>
        </header>

        <section className="content-grid async-grid">
          <div className="main-column">
            <section className="video-panel" aria-label="Original video upload">
              <div
                className={`drop-zone ${localVideoUrl ? "has-video" : ""}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  handleFile(event.dataTransfer.files?.[0]);
                }}
              >
                {localVideoUrl ? (
                  <video
                    ref={videoRef}
                    src={localVideoUrl}
                    controls
                    onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration)}
                    onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                  />
                ) : (
                  <div className="empty-upload">
                    <Upload size={34} />
                    <strong>Select the original match video</strong>
                    <span>{isFixtureMode ? "The file stays in this browser while deterministic demo events are generated." : "The browser uploads this file once. The backend handles windowing and clips."}</span>
                  </div>
                )}
                <input
                  id="video-upload"
                  type="file"
                  accept=".mp4,.mov,.avi,.mkv,.m4v,.webm,video/mp4,video/quicktime,video/x-msvideo,video/x-matroska,video/webm"
                  onChange={(event) => handleFile(event.target.files?.[0])}
                />
              </div>

              <div className="upload-actions async-actions">
                <label className="button secondary" htmlFor="video-upload">
                  <Upload size={16} />
                  Choose video
                </label>
                <button className="button primary" onClick={startWorkflow} disabled={!canStart || uploadState === "uploading"}>
                  {uploadState === "uploading" || uploadState === "initiating" ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                  {isFixtureMode ? "Run local fixture" : "Start backend job"}
                </button>
                <button className="button ghost" onClick={resetWorkflow}>
                  <RotateCcw size={16} />
                  Reset job
                </button>
                <div className="file-readout">
                  <span>{selectedFile ? selectedFile.name : "No video selected"}</span>
                  <small>{selectedFile ? `${formatBytes(selectedFile.size)} · ${videoDuration ? formatTime(videoDuration) : "metadata pending"}` : "Waiting for file"}</small>
                </div>
              </div>
              {fileError && <p className="error-line">{fileError}</p>}
              {isFixtureMode && selectedFile && !videoDuration && <p className="hint-line">Loading video metadata before the local run can start…</p>}
            </section>

            <section className="timeline-panel" aria-label="Match event timeline">
              <div className="section-heading">
                <div>
                  <h2>Event Timeline</h2>
                  <p>{visibleEvents.length} visible events · confidence threshold {Math.round(threshold * 100)}%</p>
                </div>
                <Clock3 size={18} />
              </div>
              <div className="timeline-controls">
                <label className="range-control">
                  <span>Confidence</span>
                  <input type="range" min="0" max="1" step="0.01" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
                  <output>{Math.round(threshold * 100)}%</output>
                </label>
                <span className="timeline-time">{formatTime(currentTime)} / {formatTime(displayDuration)}</span>
              </div>
              <div
                className="timeline"
                role="group"
                aria-label="Match timeline"
                tabIndex="0"
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  seekToTime(((event.clientX - bounds.left) / bounds.width) * displayDuration);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") seekToTime(currentTime - 5);
                  if (event.key === "ArrowRight") seekToTime(currentTime + 5);
                }}
              >
                {visibleEvents.map((event) => (
                  <button
                    type="button"
                    className={`marker ${selectedEventId === event.event_id ? "active" : ""}`}
                    key={event.event_id}
                    title={`${event.label} · ${formatTime(event.timestamp_sec)} · ${Math.round(event.confidence * 100)}%`}
                    aria-label={`${event.label} at ${formatTime(event.timestamp_sec)}`}
                    style={{ left: `${(event.timestamp_sec / displayDuration) * 100}%`, backgroundColor: eventColor(event.class_id, eventTypes) }}
                    onClick={(clickEvent) => {
                      clickEvent.stopPropagation();
                      selectEvent(event);
                    }}
                  />
                ))}
                <span className="playhead" style={{ left: `${(currentTime / displayDuration) * 100}%` }} aria-hidden="true" />
                <div className="timeline-axis"><span>00:00:00</span><span>{formatTime(displayDuration / 2)}</span><span>{formatTime(displayDuration)}</span></div>
              </div>
              {selectedEvent ? (
                <div className="event-detail">
                  <div>
                    <span className="detail-kicker">Selected event</span>
                    <strong>{selectedEvent.label}</strong>
                  </div>
                  <div><span>Timestamp</span><strong>{formatTime(selectedEvent.timestamp_sec)}</strong></div>
                  <div><span>Confidence</span><strong>{Math.round(selectedEvent.confidence * 100)}%</strong></div>
                  <div><span>Clip window</span><strong>{formatTime(buildClipCandidates([selectedEvent], displayDuration)[0]?.start_sec)} - {formatTime(buildClipCandidates([selectedEvent], displayDuration)[0]?.end_sec)}</strong></div>
                </div>
              ) : <p className="muted-line timeline-empty">Select a marker to inspect its event-centered window.</p>}
            </section>

            <section className="events-panel" aria-label="Generated clips">
              <div className="section-heading">
                <div>
                  <h2>Clip Candidates</h2>
                  <p>
                    {displayClips.length} visible · {selectedClips.length} selected · {isFixtureMode ? "generated locally from fixture events" : `${clips.length} total · ${readyClips.length} ready`}
                  </p>
                </div>
                <Film size={18} />
              </div>

              <div className="clip-grid">
                {displayClips.length ? (
                  displayClips.map((clip) => (
                    <article className={`clip-card ${clip.status} ${selectedClipIds.includes(clip.clip_id) ? "selected" : ""}`} key={clip.clip_id} onClick={() => selectClip(clip)}>
                      <div className="clip-media">
                        {clip.status === "ready" && clip.video_url ? (
                          <video src={clipPlaybackUrl(clip)} poster={clipThumbnailUrl(clip) || undefined} controls preload="metadata" />
                        ) : clip.status === "ready" ? (
                          <div className="clip-placeholder fixture-preview"><Play size={22} /><span>Preview in player</span></div>
                        ) : (
                          <div className="clip-placeholder">
                            {clip.status === "failed" ? <AlertTriangle size={22} /> : <Loader2 className="spin" size={22} />}
                            <span>{clip.status}</span>
                          </div>
                        )}
                      </div>
                      <div className="clip-body">
                        <div className="clip-title-row">
                          <label className="clip-select" onClick={(event) => event.stopPropagation()}>
                            <input type="checkbox" checked={selectedClipIds.includes(clip.clip_id)} onChange={() => toggleClipSelection(clip.clip_id)} aria-label={`Select ${clip.label || "clip"}`} />
                            <strong>{clip.event_types?.join(", ") || clip.label || "highlight"}</strong>
                          </label>
                          <span>{clip.score === null || clip.score === undefined ? "score n/a" : `${Math.round(Number(clip.score) * 100)}%`}</span>
                        </div>
                        <p>
                          {formatTime(clip.start_sec)} - {formatTime(clip.end_sec)} · {formatTime(clip.duration_sec)}
                        </p>
                        <div className="clip-tags">
                          {(clip.event_types || []).map((type) => (
                            <span key={type} style={{ borderColor: eventColor(type, eventTypes) }}>
                              {type}
                            </span>
                          ))}
                        </div>
                        {selectedClipIds.includes(clip.clip_id) && <div className="clip-order-controls" onClick={(event) => event.stopPropagation()}>
                          <span>Export order {selectedClipIds.indexOf(clip.clip_id) + 1}</span>
                          <button type="button" className="icon-button" onClick={() => moveClip(clip.clip_id, -1)} disabled={selectedClipIds.indexOf(clip.clip_id) === 0} aria-label="Move clip earlier"><ChevronUp size={15} /></button>
                          <button type="button" className="icon-button" onClick={() => moveClip(clip.clip_id, 1)} disabled={selectedClipIds.indexOf(clip.clip_id) === selectedClipIds.length - 1} aria-label="Move clip later"><ChevronDown size={15} /></button>
                        </div>}
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="empty-results">
                    <FileVideo size={28} />
                    <strong>No clips yet</strong>
                    <span>Start a job and keep this page open. Ready clips will appear incrementally.</span>
                  </div>
                )}
              </div>
            </section>
          </div>

          <aside className="control-column">
            <section className="control-panel" aria-label="Match metadata">
              <div className="section-heading">
                <div>
                  <h2>Match Metadata</h2>
                  <p>{isFixtureMode ? "Used by the local fixture adapter." : "Sent with `/api/matches/initiate`."}</p>
                </div>
                <Video size={18} />
              </div>
              <div className="metadata-grid">
                <label className="field">
                  Match name
                  <input value={matchName} onChange={(event) => setMatchName(event.target.value)} />
                </label>
                <label className="field">
                  Team A
                  <input value={teamA} onChange={(event) => setTeamA(event.target.value)} />
                </label>
                <label className="field">
                  Team B
                  <input value={teamB} onChange={(event) => setTeamB(event.target.value)} />
                </label>
                <label className="field">
                  Half
                  <select value={half} onChange={(event) => setHalf(event.target.value)}>
                    <option value="">Unknown</option>
                    <option value="1">First half</option>
                    <option value="2">Second half</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="control-panel" aria-label="Highlight event types">
              <div className="section-heading">
                <div>
                  <h2>Event Types</h2>
                  <p>Backend can add more later.</p>
                </div>
                <Flag size={18} />
              </div>
                <div className="event-type-grid async-event-grid">
                {eventTypes.map((event) => (
                  <label key={event.id} className="check-row">
                    <input type="checkbox" checked={selectedTypes.has(event.id)} onChange={() => toggleEventType(event.id)} />
                    <span style={{ backgroundColor: event.color }} />
                    {event.label}
                  </label>
                ))}
              </div>
              <p className="muted-line">The first milestone targets six SoccerNet event classes.</p>
            </section>

            <section className="control-panel" aria-label="Job progress">
              <div className="section-heading">
                <div>
                  <h2>Job Progress</h2>
                  <p>Backend: {backendLabel}</p>
                </div>
                <Radio size={18} />
              </div>
              <div className="progress-card">
                <div className="progress-row">
                  <span>Upload</span>
                  <strong>{uploadProgress}%</strong>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
              <div className="progress-card">
                <div className="progress-row">
                  <span>Processing</span>
                  <strong>{processingProgress === null ? processingLabel : `${processingProgress}%`}</strong>
                </div>
                <div className={`progress-track ${processingProgress === null && processingState !== "idle" ? "is-indeterminate" : ""}`}>
                  <span className={progressStyle} style={{ width: `${processingProgress ?? 35}%` }} />
                </div>
              </div>
              <div className="job-ids">
                <span>match_id</span>
                <code>{match?.match_id || "not created"}</code>
                <span>job_id</span>
                <code>{job?.job_id || "not started"}</code>
              </div>
            </section>

            <section className="control-panel" aria-label="Export results">
              <div className="section-heading">
                <div>
                  <h2>Export</h2>
                  <p>{selectedClips.length ? `${selectedClips.length} selected clips` : "All visible clips if none are selected"}</p>
                </div>
                <Download size={18} />
              </div>
              <div className="export-actions">
                <button className="button secondary compact" onClick={() => exportManifest("json")} disabled={!displayClips.length}><Download size={15} /> JSON manifest</button>
                <button className="button ghost compact" onClick={() => exportManifest("csv")} disabled={!displayClips.length}><Download size={15} /> CSV manifest</button>
              </div>
            </section>

            <section className="control-panel" aria-label="Processing events">
              <div className="section-heading">
                <div>
                  <h2>Processing Events</h2>
                  <p>{connectionMode === "sse" ? "Server-Sent Events" : connectionMode === "polling" ? "Polling fallback" : "Waiting"}</p>
                </div>
                <Clock3 size={18} />
              </div>
              <div className="activity-list">
                {activityLog.length ? (
                  activityLog.map((item) => (
                    <div className="activity-item" key={item.id}>
                      <strong>{item.type}</strong>
                      <span>{item.label}</span>
                    </div>
                  ))
                ) : (
                  <p className="muted-line">No backend events yet.</p>
                )}
              </div>
            </section>

            {message && <div className={`message ${processingState === "failed" || uploadState === "failed" ? "error" : ""}`}>{message}</div>}
          </aside>
        </section>
      </main>
    </div>
  );
}

export default App;
