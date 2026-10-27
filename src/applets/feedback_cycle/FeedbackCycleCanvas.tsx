import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMp4SupportedSync } from "../../core/canvasRecorder";
import { AppletHostAdapter } from "../../core/host";
import { exportOfflineVideo } from "../../core/offlineVideoExport";
import { AppletStage } from "../../ui/stage/AppletStage";
import {
  StageDivider,
  StageIconButton,
  StagePillButton,
  StagePills,
  StageReadout,
  StageSection,
  StageSegmented,
  StageSelect,
  StageSlider,
  StageToggle
} from "../../ui/stage/StageControls";
import { renderFeedbackScene, SCENE_H, SCENE_W, SceneOptions } from "./render";
import { createSimStore, SimStore } from "./simStore";
import { chapterIndexAt, CHAPTERS, filmAt, formatMyr, formatSfr, SIM_END_MYR, STORY_DURATION } from "./timeline";

type Props = {
  host?: AppletHostAdapter;
};

const TIP = {
  play: "Play or pause the film (Space).",
  prev: "Back to the start of this chapter, or the previous one (← or Page Up).",
  next: "Continue, or skip to the next chapter (→ or Page Down). Presentation clickers send these keys.",
  restart: "Back to the very beginning.",
  playback: "Playback speed. Only the pace on screen changes.",
  cinematic:
    "Hide everything except time and the star formation rate (C). Click the film to play or pause; the corner button or C brings the controls back.",
  chapter: "Jump to a chapter.",
  story: "Scrub through the film.",
  feedback:
    "Strength of supernova feedback (energy and momentum per supernova, and early winds). The rest emerges: stronger feedback holds star formation lower.",
  newRun: "Different random starting gas; the physics stays the same. The simulation is recomputed.",
  captions: "Chapter titles and explanations, bottom left.",
  clock: "Time and star formation rate, top right.",
  labels: "Short labels pointing at the hot wind, the fountain and the inflow in the galaxy-scale chapters.",
  graphs: "Star formation rate over time, the Kennicutt–Schmidt diagram and the feedback loop.",
  timeline: "Chapter timeline along the bottom edge.",
  pauseBetween: "Hold just before each chapter ends, so you can talk; → or Page Down continues.",
  progress: "The patch is simulated in the background when the film opens; it plays as far as it is computed.",
  resolution: "Video size. 1080p is best for a talk; 720p exports faster and works on more browsers.",
  fps: "Frames per second of the video.",
  videoSpeed: "½× renders the film in slow motion: twice as long, every frame newly drawn.",
  cleanVideo: "Video with only time and the star formation rate over the film, as in cinematic mode.",
  exportBtn: "Render the whole film off-screen and download it. Uses the on-screen options above.",
  exportWait: "Available once the simulation has finished.",
  cancel: "Stop exporting; nothing is downloaded."
} as const;

const PLAYBACK_OPTIONS = [
  { value: 0.5, label: "½×" },
  { value: 1, label: "1×" },
  { value: 2, label: "2×" }
];

const FEEDBACK_OPTIONS: { value: number; label: string; tip: string }[] = [
  { value: 0.4, label: "Weak", tip: "40% of the standard supernova energy and momentum." },
  { value: 1, label: "Standard", tip: "10⁵¹ erg and ~3 × 10⁵ M☉ km/s per supernova, plus early winds." },
  { value: 2.5, label: "Strong", tip: "2.5× the standard feedback." }
];

const HOLD_BEFORE_END = 0.55;
const DEFAULT_SEED = 7;

type ExportMessage = { short: string; detail: string };
type ExportState = { running: boolean; done: number; total: number; message: ExportMessage | null };

export function FeedbackCycleCanvas({ host }: Props): JSX.Element {
  const sceneRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = host?.readReducedMotion?.() ?? false;

  const [playing, setPlaying] = useState(false);
  const [playback, setPlayback] = useState<number>(reducedMotion ? 0.5 : 1);
  const [pauseBetween, setPauseBetween] = useState(false);
  const [scene, setScene] = useState<SceneOptions>({
    captions: true,
    clock: true,
    labels: true,
    graphs: true,
    timeline: false,
    gentle: reducedMotion,
    minimal: false
  });
  const [cinematic, setCinematic] = useState(false);
  const [story, setStory] = useState(0);
  const [feedback, setFeedback] = useState(1);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [progress, setProgress] = useState(0);
  const [simDone, setSimDone] = useState(false);
  const [resolution, setResolution] = useState<1080 | 720>(1080);
  const [fps, setFps] = useState<30 | 60>(30);
  const [videoSpeed, setVideoSpeed] = useState<0.5 | 1>(1);
  const [cleanVideo, setCleanVideo] = useState(false);
  const [exporting, setExporting] = useState<ExportState>({ running: false, done: 0, total: 0, message: null });
  const exportCancel = useRef(false);

  const storeRef = useRef<SimStore | null>(null);
  useEffect(() => {
    setSimDone(false);
    setProgress(0);
    const store = createSimStore(seed, feedback, () => {
      setProgress(Math.max(0, store.ready()) / SIM_END_MYR);
      if (store.done()) {
        setSimDone(true);
      }
    });
    storeRef.current = store;
    return () => store.dispose();
  }, [seed, feedback]);

  const storyRef = useRef(0);
  const shownScene: SceneOptions = cinematic ? { ...scene, minimal: true } : scene;
  const live = useRef({ playing, playback, pauseBetween, scene: shownScene, exporting: false });
  live.current = { playing, playback, pauseBetween, scene: shownScene, exporting: exporting.running };

  const drawNow = useCallback(() => {
    const sctx = sceneRef.current?.getContext("2d");
    const store = storeRef.current;
    if (sctx && store && !live.current.exporting) {
      renderFeedbackScene(sctx, store, storyRef.current, live.current.scene);
    }
  }, []);

  useEffect(() => {
    let last = performance.now();
    let lastReadout = -Infinity;
    let raf = 0;
    const tick = (time: number): void => {
      const dt = Math.min(0.1, (time - last) / 1000);
      last = time;
      const now = live.current;
      const store = storeRef.current;
      if (now.playing && !now.exporting && store) {
        const s = storyRef.current;
        let next = s + dt * now.playback;
        let hold = false;
        if (now.pauseBetween) {
          const holdAt = CHAPTERS[chapterIndexAt(s)].end - HOLD_BEFORE_END;
          if (s < holdAt - 1e-6 && next >= holdAt) {
            next = holdAt;
            hold = true;
          }
        }
        // Do not run ahead of the simulation.
        if (!store.done() && filmAt(next).tMyr > store.ready()) {
          next = s;
        }
        storyRef.current = Math.min(STORY_DURATION, next);
        if (hold || storyRef.current >= STORY_DURATION) {
          setPlaying(false);
        }
      }
      drawNow();
      if (time - lastReadout > 200) {
        lastReadout = time;
        setStory(storyRef.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [drawNow]);

  const seek = useCallback(
    (to: number) => {
      storyRef.current = Math.min(STORY_DURATION, Math.max(0, to));
      setStory(storyRef.current);
      drawNow();
    },
    [drawNow]
  );

  const togglePlay = useCallback(() => {
    if (live.current.exporting) {
      return;
    }
    if (!live.current.playing && storyRef.current >= STORY_DURATION - 1e-6) {
      seek(0);
    }
    setPlaying((p) => !p);
  }, [seek]);

  const next = useCallback(() => {
    if (live.current.exporting) {
      return;
    }
    const s = storyRef.current;
    const index = chapterIndexAt(s);
    const holdAt = CHAPTERS[index].end - HOLD_BEFORE_END;
    if (!live.current.playing && Math.abs(s - holdAt) < 0.05 && index < CHAPTERS.length - 1) {
      seek(s + HOLD_BEFORE_END + 1e-3);
      setPlaying(true);
      return;
    }
    if (index < CHAPTERS.length - 1) {
      seek(CHAPTERS[index + 1].start);
      setPlaying(true);
    }
  }, [seek]);

  const prev = useCallback(() => {
    if (live.current.exporting) {
      return;
    }
    const s = storyRef.current;
    const index = chapterIndexAt(s);
    seek(s - CHAPTERS[index].start > 1.5 || index === 0 ? CHAPTERS[index].start : CHAPTERS[index - 1].start);
  }, [seek]);

  const restart = useCallback(() => {
    setPlaying(false);
    seek(0);
    host?.onResult?.({ event: "restart" });
  }, [seek, host]);

  const setCinematicMode = useCallback(
    (on: boolean) => {
      setCinematic(on);
      drawNow();
    },
    [drawNow]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.altKey || e.ctrlKey || e.metaKey) {
        return;
      }
      if (e.key === " " && tag !== "BUTTON") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        prev();
      } else if (e.key === "Home") {
        e.preventDefault();
        restart();
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        setCinematic((on) => !on);
      } else if (e.key === "Escape" && !document.fullscreenElement) {
        setCinematic(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, next, prev, restart]);

  function setOption<K extends keyof SceneOptions>(key: K, value: SceneOptions[K]): void {
    const nextScene = { ...scene, [key]: value };
    live.current.scene = cinematic ? { ...nextScene, minimal: true } : nextScene;
    setScene(nextScene);
    drawNow();
  }

  async function startExport(): Promise<void> {
    const store = storeRef.current;
    if (!store || !store.done()) {
      return;
    }
    setPlaying(false);
    exportCancel.current = false;
    const height = resolution;
    const width = Math.round((height * SCENE_W) / SCENE_H);
    const total = Math.round((STORY_DURATION * fps) / videoSpeed);
    const videoScene = cleanVideo ? { ...scene, minimal: true } : scene;
    setExporting({ running: true, done: 0, total, message: null });
    live.current.exporting = true;
    const result = await exportOfflineVideo({
      width,
      height,
      fps,
      totalFrames: total,
      filenameStem: "feedback_cycle",
      renderFrame: (ctx, i) => renderFeedbackScene(ctx, store, (i * videoSpeed) / fps, videoScene),
      onProgress: (done, all, preview) => {
        setExporting({ running: true, done, total: all, message: null });
        const sctx = sceneRef.current?.getContext("2d");
        if (sctx && sceneRef.current) {
          sctx.setTransform(1, 0, 0, 1, 0, 0);
          sctx.drawImage(preview, 0, 0, sceneRef.current.width, sceneRef.current.height);
        }
      },
      isCancelled: () => exportCancel.current
    });
    live.current.exporting = false;
    const message: ExportMessage =
      result.status === "done"
        ? {
            short: result.format === "mp4" ? "saved MP4" : "saved zip",
            detail: `Saved as ${result.format === "mp4" ? "an MP4 video" : "a zip of frames"} in your downloads.`
          }
        : result.status === "cancelled"
          ? { short: "cancelled", detail: "Export cancelled; nothing was saved." }
          : { short: "failed", detail: `Export failed: ${result.message ?? "unknown error"}` };
    setExporting({ running: false, done: 0, total: 0, message });
    host?.onResult?.({ event: "export", status: result.status });
  }

  const film = filmAt(story);
  const chapterIndex = film.chapterIndex;
  const mp4 = useMemo(() => isMp4SupportedSync(), []);
  const exportProgress = exporting.total > 0 ? Math.round((100 * exporting.done) / exporting.total) : 0;
  const nowFrame = storeRef.current?.frame("main", film.tMyr);

  const toolbar = (
    <>
      <StagePillButton label="‹" tip={TIP.prev} disabled={exporting.running} onClick={prev} />
      <StageIconButton
        icon={playing ? "pause" : "play"}
        label={playing ? "Pause" : "Play"}
        tip={TIP.play}
        disabled={exporting.running}
        onClick={togglePlay}
      />
      <StagePillButton label="›" tip={TIP.next} disabled={exporting.running} onClick={next} />
      <StageIconButton icon="reset" label="Restart" tip={TIP.restart} disabled={exporting.running} onClick={restart} />
      <StageDivider />
      <StageSegmented ariaLabel="Playback speed" tip={TIP.playback} value={playback} options={PLAYBACK_OPTIONS} onChange={setPlayback} />
      <StageDivider />
      <StagePillButton label="Cinematic" tip={TIP.cinematic} disabled={exporting.running} onClick={() => setCinematicMode(true)} />
    </>
  );

  const controls = (
    <>
      <StageSection title="Film">
        <StageSelect
          label="Chapter"
          tip={TIP.chapter}
          value={CHAPTERS[chapterIndex].id}
          options={CHAPTERS.map((c, i) => ({ value: c.id, label: `${i + 1}. ${c.title}` }))}
          disabled={exporting.running}
          onChange={(id) => seek(CHAPTERS.find((c) => c.id === id)?.start ?? 0)}
        />
        <StageSlider
          label="Position"
          display={`${story.toFixed(1)} / ${STORY_DURATION} s`}
          value={story}
          min={0}
          max={STORY_DURATION}
          step={0.1}
          tip={TIP.story}
          disabled={exporting.running}
          onChange={seek}
        />
        <StageReadout label="Simulated" tip={TIP.progress} value={simDone ? "all done" : `${Math.round(progress * 100)}%`} />
      </StageSection>
      <StageSection title="Physics">
        <StageSegmented
          ariaLabel="Feedback strength"
          label="Supernova feedback"
          tip={TIP.feedback}
          value={feedback}
          options={FEEDBACK_OPTIONS}
          disabled={exporting.running}
          onChange={setFeedback}
        />
        <StagePills>
          <StagePillButton label="New random patch" tip={TIP.newRun} disabled={exporting.running} onClick={() => setSeed((s) => s + 1)} />
        </StagePills>
      </StageSection>
      <StageSection title="On screen">
        <StagePills>
          <StageToggle label="Captions" tip={TIP.captions} on={scene.captions} onChange={(on) => setOption("captions", on)} />
          <StageToggle label="Clock" tip={TIP.clock} on={scene.clock} onChange={(on) => setOption("clock", on)} />
          <StageToggle label="Labels" tip={TIP.labels} on={scene.labels} onChange={(on) => setOption("labels", on)} />
          <StageToggle label="Graphs" tip={TIP.graphs} on={scene.graphs} onChange={(on) => setOption("graphs", on)} />
          <StageToggle label="Timeline" tip={TIP.timeline} on={scene.timeline} onChange={(on) => setOption("timeline", on)} />
        </StagePills>
      </StageSection>
      <StageSection title="Presenting">
        <StagePills>
          <StageToggle label="Pause between chapters" tip={TIP.pauseBetween} on={pauseBetween} onChange={setPauseBetween} />
        </StagePills>
      </StageSection>
      <StageSection title="Export video" defaultOpen={false}>
        <StageSegmented
          ariaLabel="Resolution"
          label="Resolution"
          tip={TIP.resolution}
          value={resolution}
          options={[
            { value: 1080, label: "1080p" },
            { value: 720, label: "720p" }
          ]}
          disabled={exporting.running}
          onChange={setResolution}
        />
        <StageSegmented
          ariaLabel="Frame rate"
          label="Frame rate"
          tip={TIP.fps}
          value={fps}
          options={[
            { value: 30, label: "30 fps" },
            { value: 60, label: "60 fps" }
          ]}
          disabled={exporting.running}
          onChange={setFps}
        />
        <StageSegmented
          ariaLabel="Video speed"
          label="Video speed"
          tip={TIP.videoSpeed}
          value={videoSpeed}
          options={[
            { value: 0.5, label: "½×" },
            { value: 1, label: "1×" }
          ]}
          disabled={exporting.running}
          onChange={setVideoSpeed}
        />
        <StagePills>
          <StageToggle label="Clean video (time & star formation only)" tip={TIP.cleanVideo} on={cleanVideo} onChange={setCleanVideo} />
        </StagePills>
        <StagePills>
          {exporting.running ? (
            <StagePillButton label={`Cancel (${exportProgress}%)`} tip={TIP.cancel} onClick={() => (exportCancel.current = true)} />
          ) : (
            <StagePillButton
              label={mp4 ? "Export MP4" : "Export frames (zip)"}
              tip={simDone ? TIP.exportBtn : TIP.exportWait}
              disabled={!simDone}
              onClick={() => void startExport()}
            />
          )}
        </StagePills>
        {exporting.running ? (
          <StageReadout label="Rendering" value={`${exporting.done} / ${exporting.total} frames`} />
        ) : exporting.message ? (
          <StageReadout label="Export" value={exporting.message.short} tip={exporting.message.detail} />
        ) : null}
      </StageSection>
      <StageSection title="What is on screen" defaultOpen={false}>
        <StageReadout label="Simulated time" value={`≈ ${formatMyr(film.tMyr)}`} />
        <StageReadout label="Star formation rate" value={`≈ ${formatSfr(nowFrame?.a.sfr ?? 0)}`} />
        <StageReadout label="Gas left" value={nowFrame ? `${Math.round(nowFrame.a.gas * 100)}%` : "—"} />
        <StageReadout label="Supernovae so far" value={nowFrame ? nowFrame.a.snCount.toLocaleString("en-US") : "—"} />
      </StageSection>
    </>
  );

  const info = (
    <>
      <h4>What you are seeing</h4>
      <ul>
        <li>
          A real (small) simulation of a 2 × 1 kpc patch of a galaxy's gas disk: gas dynamics with self-gravity and
          cooling, star formation and supernova feedback. Two runs share the same starting gas: one with feedback,
          one without.
        </li>
        <li>
          Stars form only in dense, cool gas, at ρ̇* = ε ρ / t_ff with ε = 2% per free-fall time (observed: about 1–3%).
          Because t_ff ∝ ρ^−½, the rate scales as ρ^1.5: the Kennicutt–Schmidt relation emerges.
        </li>
        <li>
          Each 10⁴ M☉ cluster has about 100 supernovae between 3 and 40 Myr of age, each giving 10⁵¹ erg (part as heat)
          and ~3 × 10⁵ M☉ km/s of momentum; winds and radiation push the gas before that.
        </li>
        <li>
          Colours: blue is gas (brighter where denser), orange is supernova-heated gas, pink is gas forming stars.
          Star clusters glow blue-white when young and yellow as they age.
        </li>
      </ul>
      <h4>Simplified on purpose</h4>
      <ul>
        <li>
          The patch is flat (2D) and periodic. Hot gas would blow out of a real disk; here its heat escapes on the time
          it takes to cross the disk's thickness (~100 pc).
        </li>
        <li>
          Cells are ~16 pc, so individual stars and supernova remnants are not resolved; clusters form once 10⁴ M☉
          has accumulated in a cell, and the cluster stars do not add to the gravity.
        </li>
        <li>Temperatures are capped at 2 × 10⁶ K and speeds at 250 km/s to keep the simulation fast and stable.</li>
        <li>
          The galaxy in the opening and closing shots is an illustration; only the patch is simulated. Its flickering
          star-forming regions illustrate the same cycle.
        </li>
        <li>
          The last two chapters are illustrations at galaxy scale, not simulated: outflow heights, the fountain and the
          inflow streams are drawn schematically. The numbers are typical values: a Milky Way-like galaxy forms about
          1.5 M☉ of stars per year, and the mass loading η follows η ≈ 3.6 (M*/10¹⁰ M☉)^−0.35 from the FIRE simulations
          (Muratov et al. 2015).
        </li>
        <li>Bloom, vignette and grain are style only.</li>
      </ul>
      <h4>Presenting</h4>
      <ul>
        <li>Space play/pause · → or Page Down next · ← or Page Up back · Home restart.</li>
        <li>C toggles cinematic mode: only time and the star formation rate on screen.</li>
      </ul>
    </>
  );

  return (
    <AppletStage
      logicalWidth={SCENE_W}
      logicalHeight={SCENE_H}
      canvasRef={sceneRef}
      canvasLabel={`Star formation and feedback, chapter ${chapterIndex + 1}: ${CHAPTERS[chapterIndex].title}`}
      onCanvasResize={drawNow}
      toolbar={toolbar}
      controls={controls}
      controlsWidth={280}
      controlsDefaultOpen={false}
      info={info}
      canvasProps={cinematic ? { onClick: togglePlay } : undefined}
      cinematic={cinematic ? { label: "Show controls (C)", onExit: () => setCinematicMode(false) } : undefined}
      play={{ visible: !playing && !exporting.running && story < 0.05, label: "Play the film", onClick: togglePlay }}
    />
  );
}
