import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock3,
  FileVideo,
  Film,
  Flag,
  Loader2,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Upload,
  Video,
} from "lucide-react";
import { apiFetch, backendBaseUrl, clipPlaybackUrl, clipThumbnailUrl, isRemoteBackend, openJobEventSource, uploadMatchVideo } from "./apiClient";
import { PitchClipersPixelLogo } from "./components/PitchClipersPixelLogo";

const DEFAULT_EVENT_TYPES = [
  { id: "goal", label: "Goal", color: "#16a34a" },
  { id: "shot", label: "Shot", color: "#2563eb" },
  { id: "header", label: "Header", color: "#0d9488" },
  { id: "high_pass", label: "High pass", color: "#f59e0b" },
  { id: "free_kick", label: "Free kick", color: "#7c3aed" },
];

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
  const [eventTypes, setEventTypes] = useState(DEFAULT_EVENT_TYPES);
  const [selectedTypes, setSelectedTypes] = useState(new Set(DEFAULT_EVENT_TYPES.map((event) => event.id)));
  const [customEventType, setCustomEventType] = useState("");
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

  const selectedTypeList = useMemo(() => Array.from(selectedTypes), [selectedTypes]);
  const readyClips = clips.filter((clip) => clip.status === "ready");
  const backendLabel = isRemoteBackend ? backendBaseUrl : "local Vite proxy -> 127.0.0.1:8000";
  const canStart = Boolean(selectedFile && !fileError && selectedTypeList.length);

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

  function addCustomEventType() {
    const id = customEventType.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!id || eventTypes.some((event) => event.id === id)) return;
    setEventTypes((previous) => [...previous, { id, label: id.replaceAll("_", " "), color: "#64748b" }]);
    setSelectedTypes((previous) => new Set([...previous, id]));
    setCustomEventType("");
  }

  async function startBackendWorkflow() {
    const error = validateVideo(selectedFile);
    setFileError(error);
    setMessage("");
    if (error) return;

    closeSse();
    stopPolling();
    setClips([]);
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
              <h1>Async Highlight Processing</h1>
              <p>Original upload, backend windowing, model inference, and incremental clip delivery.</p>
            </div>
          </div>
          <div className={`status-pill ${processingState === "completed" ? "ready" : ""}`}>
            {processingState === "processing" || processingState === "queued" || processingState === "starting" ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}
            {connectionMode === "sse" ? "SSE connected" : connectionMode === "polling" ? "Polling fallback" : "Backend ready"}
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
                  <video src={localVideoUrl} controls onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration)} />
                ) : (
                  <div className="empty-upload">
                    <Upload size={34} />
                    <strong>Select the original match video</strong>
                    <span>The browser uploads this file once. The backend handles windowing and clips.</span>
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
                <button className="button primary" onClick={startBackendWorkflow} disabled={!canStart || uploadState === "uploading"}>
                  {uploadState === "uploading" || uploadState === "initiating" ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                  Start backend job
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
            </section>

            <section className="events-panel" aria-label="Generated clips">
              <div className="section-heading">
                <div>
                  <h2>Generated Clips</h2>
                  <p>
                    {clips.length} total · {readyClips.length} ready · clips appear as backend `clip_ready` events arrive
                  </p>
                </div>
                <Clock3 size={18} />
              </div>

              <div className="clip-grid">
                {clips.length ? (
                  clips.map((clip) => (
                    <article className={`clip-card ${clip.status}`} key={clip.clip_id}>
                      <div className="clip-media">
                        {clip.status === "ready" ? (
                          <video src={clipPlaybackUrl(clip)} poster={clipThumbnailUrl(clip) || undefined} controls preload="metadata" />
                        ) : (
                          <div className="clip-placeholder">
                            {clip.status === "failed" ? <AlertTriangle size={22} /> : <Loader2 className="spin" size={22} />}
                            <span>{clip.status}</span>
                          </div>
                        )}
                      </div>
                      <div className="clip-body">
                        <div className="clip-title-row">
                          <strong>{clip.event_types?.join(", ") || "highlight"}</strong>
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
                  <p>Sent with `/api/matches/initiate`.</p>
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
              <div className="add-event-row">
                <input value={customEventType} placeholder="Add event type" onChange={(event) => setCustomEventType(event.target.value)} />
                <button className="icon-button" onClick={addCustomEventType} aria-label="Add event type">
                  <Plus size={16} />
                </button>
              </div>
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
