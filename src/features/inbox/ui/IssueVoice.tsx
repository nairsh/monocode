import { useEffect, useRef, useState } from "react";
import { Modal } from "../../../shared/ui/Modal";
import { Square } from "../../../shared/ui/icons";
import { projectName } from "../../../shared/lib/paths";
import { loadLocalIssues, type LocalIssue } from "../model/localIssues";
import { applyIssueVoicePlan, type IssueVoicePlan } from "../model/issueVoice";
import { planIssueVoiceCommand } from "../model/issueVoiceAgent";
import "./IssueVoice.css";

type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type VoiceWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
function Mic() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
      className="it-icon"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0014 0v-2M12 19v3m-4 0h8" />
    </svg>
  );
}

export function IssueVoice({
  projects,
  initialProject,
  onLaunch,
}: {
  projects: string[];
  initialProject: string;
  onLaunch?: (issue: LocalIssue) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="it-chip"
        onClick={() => setOpen(true)}
        aria-label="Voice commands"
      >
        <Mic /> Voice
      </button>
      {open ? (
        <VoiceDialog
          projects={projects}
          initialProject={initialProject}
          onLaunch={onLaunch}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function VoiceDialog({
  projects,
  initialProject,
  onLaunch,
  onClose,
}: {
  projects: string[];
  initialProject: string;
  onLaunch?: (issue: LocalIssue) => Promise<void>;
  onClose: () => void;
}) {
  const [project, setProject] = useState(initialProject || projects[0] || "");
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState<"planning" | "applying" | null>(null);
  const [plan, setPlan] = useState<IssueVoicePlan>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const recognition = useRef<Recognition | null>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const meter = useRef<HTMLDivElement>(null);
  const audio = useRef<{
    stream: MediaStream;
    context: AudioContext;
    frame: number;
  } | null>(null);
  const starting = useRef(false);
  const Constructor =
    (window as VoiceWindow).SpeechRecognition ??
    (window as VoiceWindow).webkitSpeechRecognition;
  const stopMeter = () => {
    const current = audio.current;
    audio.current = null;
    if (current) {
      cancelAnimationFrame(current.frame);
      current.stream.getTracks().forEach((track) => track.stop());
      void current.context.close();
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recognition.current?.abort();
      pending.current?.abort();
      stopMeter();
    };
  }, []);
  const record = async () => {
    if (!Constructor || starting.current || recognition.current) return;
    starting.current = true;
    setError("");
    setNotice("");
    setPlan(undefined);
    const prefix = text.trim();
    try {
      const recorder = new Constructor();
      recognition.current = recorder;
      recorder.lang = navigator.language || "en-US";
      recorder.continuous = true;
      recorder.interimResults = true;
      recorder.onresult = (event) => {
        if (!mounted.current) return;
        const transcript = Array.from(
          event.results,
          (result) => result[0].transcript,
        ).join(" ");
        setText([prefix, transcript].filter(Boolean).join(" "));
      };
      recorder.onerror = (event) => {
        if (mounted.current && event.error !== "aborted")
          setError(
            event.error === "not-allowed"
              ? "Microphone permission was denied. Allow microphone access or type your command."
              : `Speech recognition stopped: ${event.error}. You can type your command.`,
          );
      };
      recorder.onend = () => {
        recognition.current = null;
        stopMeter();
        if (mounted.current) setListening(false);
      };
      recorder.start();
      setListening(true);
      // Meter is optional: recognition remains usable when Web Audio is unavailable.
      if (
        navigator.mediaDevices?.getUserMedia &&
        typeof AudioContext !== "undefined"
      ) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (!mounted.current || recognition.current !== recorder) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 64;
        context.createMediaStreamSource(stream).connect(analyser);
        audio.current = { stream, context, frame: 0 };
        const samples = new Uint8Array(analyser.frequencyBinCount);
        const draw = () => {
          if (!audio.current) return;
          analyser.getByteFrequencyData(samples);
          Array.from(meter.current?.children ?? []).forEach((bar, index) => {
            (bar as HTMLElement).style.transform =
              `scaleY(${0.12 + (samples[index % samples.length] / 255) * 0.88})`;
          });
          audio.current.frame = requestAnimationFrame(draw);
        };
        draw();
      }
    } catch (cause) {
      recognition.current?.abort();
      recognition.current = null;
      stopMeter();
      if (mounted.current) {
        setListening(false);
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not start the microphone.",
        );
      }
    } finally {
      starting.current = false;
    }
  };
  const review = async () => {
    const controller = new AbortController();
    pending.current = controller;
    setBusy("planning");
    setError("");
    setNotice("");
    setPlan(undefined);
    try {
      const result = await planIssueVoiceCommand(
        text,
        project,
        loadLocalIssues(),
        controller.signal,
      );
      if (mounted.current) setPlan(result);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not understand the command.",
        );
    } finally {
      pending.current = null;
      if (mounted.current) setBusy(null);
    }
  };
  const apply = async () => {
    if (!plan || busy) return;
    setBusy("applying");
    setError("");
    let applied = 0;
    try {
      await applyIssueVoicePlan(plan, onLaunch, () => {
        applied++;
        if (mounted.current)
          setNotice(`Completed ${applied} of ${plan.actions.length} actions`);
      });
      if (mounted.current) {
        setPlan(undefined);
        setText("");
        setNotice(`Completed ${applied} actions`);
      }
    } catch (cause) {
      if (mounted.current) {
        setPlan(undefined);
        setError(
          `${applied ? `${applied} actions completed. ` : ""}${cause instanceof Error ? cause.message : "Command failed."} Review the current board before retrying.`,
        );
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  return (
    <Modal title="Issue commands" onClose={onClose} size="md" fitViewport>
      <div
        className="issue-voice"
        data-voice-state={listening ? "listening" : (busy ?? "idle")}
      >
        <label>
          Project
          <select
            aria-label="Command project"
            value={project}
            disabled={!!busy || listening}
            onChange={(event) => {
              setProject(event.target.value);
              setPlan(undefined);
            }}
          >
            {!projects.length ? (
              <option value="">Open a project first</option>
            ) : (
              projects.map((path) => (
                <option key={path} value={path}>
                  {projectName(path)}
                </option>
              ))
            )}
          </select>
        </label>
        <div className="voice-capture">
          <div ref={meter} className="voice-meter" aria-hidden="true">
            {Array.from({ length: 32 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
          <button
            type="button"
            className="voice-record"
            disabled={!Constructor || !!busy}
            aria-label={listening ? "Stop listening" : "Start listening"}
            aria-pressed={listening}
            onClick={() =>
              listening ? recognition.current?.stop() : void record()
            }
          >
            {listening ? <Square className="it-icon" /> : <Mic />}
          </button>
          <p role="status">
            {listening
              ? "Listening…"
              : busy === "planning"
                ? "Understanding your command…"
                : busy === "applying"
                  ? "Applying actions…"
                  : "Tell your board what to do"}
          </p>
        </div>
        {!Constructor ? (
          <p className="voice-hint">
            Speech recognition is unavailable in this runtime. Type a command
            below.
          </p>
        ) : (
          <p className="voice-hint">
            Speech recognition uses your browser’s speech service. Review the
            transcript before applying.
          </p>
        )}
        <textarea
          aria-label="Issue command"
          placeholder={
            "Create an issue called Fix login\nSet MC-1 priority to high\nStart an agent on MC-1"
          }
          value={text}
          disabled={!!busy || listening}
          onChange={(event) => {
            setText(event.target.value);
            setPlan(undefined);
          }}
          rows={4}
        />
        {error ? (
          <p role="alert" className="voice-error">
            {error}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        {plan ? (
          <ol className="voice-actions">
            {plan.actions.map((action, index) => (
              <li key={index}>
                <strong>
                  {action.action.replace("issues.", "")}{" "}
                  {action.input.issueId
                    ? `· ${plan.snapshot.find((issue) => issue.id === action.input.issueId)?.title}`
                    : "issue"}
                </strong>
                <pre>{JSON.stringify(action.input, null, 2)}</pre>
                {action.startAgent ? <span>Then start an agent</span> : null}
              </li>
            ))}
          </ol>
        ) : null}
        <div className="voice-footer">
          {busy === "planning" ? (
            <button
              onClick={() => {
                pending.current?.abort();
              }}
            >
              Cancel
            </button>
          ) : null}
          <span className="voice-hint">
            {plan
              ? `${plan.actions.length} actions in ${projectName(project)}`
              : "Changes use the board’s issue and agent tools."}
          </span>
          <button
            className="it-primary"
            disabled={!text.trim() || !project || !!busy || listening}
            onClick={() => void (plan ? apply() : review())}
          >
            {plan ? "Apply actions" : "Review command"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
