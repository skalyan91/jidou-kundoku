/** Keeps the kundoku and kakikudashi panels' horizontal scroll positions in
 * lockstep by *sentence*, not raw pixel offset — the two panels render the
 * same sentences at different widths (kundoku carries furigana/kunten,
 * kakikudashi doesn't), so a naive `scrollLeft` mirror would drift out of
 * alignment after the first sentence. Both panels are `vertical-rl`, so
 * reading (and block-progression) starts at each panel's own *right* edge
 * and proceeds leftward — "which sentence is currently leading" is
 * therefore whichever `.sentence-gap`'s right edge sits closest to (at or
 * just past) the panel's own right edge. */
export function setupScrollSync(panelA: HTMLElement, panelB: HTMLElement): void {
  // Where this module last put each panel, so its own writes can be told
  // apart from a real user scroll that should sync the other panel in turn.
  //
  // Identifying them by *position* rather than by counting pending writes is
  // what makes this robust to the browser coalescing several writes into one
  // 'scroll' event, or dropping one: an entry nothing claims is simply a
  // position that never comes back, and the next genuine scroll — which
  // lands somewhere else — matches nothing and syncs normally. That last
  // step only holds because an entry is never recorded for a write that
  // moved nothing; `writeTarget` says what went wrong when it was.
  //
  // Two earlier guards were tried and both failed on a timing assumption: a
  // boolean reset on a
  // `requestAnimationFrame` (the event can arrive a frame later), and the
  // same boolean consumed from inside the listener (one slot cannot hold two
  // pending writes, so the second event went unsuppressed).
  //
  // The recorded value is read back *after* the write rather than being the
  // value asked for, so a write the browser clamps (asking for 0 on a panel
  // already there, or past either end) still records where the panel
  // actually landed.
  //
  // One slot per panel still suffices now that a sync is a whole animation
  // rather than a single write, because the animation writes at most once
  // per frame and the listener reads the panel's *live* `scrollLeft`: an
  // event that arrives late still reads whatever the newest write landed at,
  // which is exactly what the slot holds. Nothing moves the panel between
  // this module's own writes for a stale value to be read at — which is the
  // one thing the browser's own smooth scrolling did, and why it broke this
  // guard (see `writeTarget`).
  const written = new Map<HTMLElement, number>();

  // An in-flight glide per panel: where it is heading, how fast it is
  // currently travelling (px/s), and the frame request that will take it
  // another step. A panel has at most one, since a fresh sync re-aims the
  // existing glide rather than starting a second one.
  interface Glide {
    goal: number;
    velocity: number;
    frame: number;
    last: number;
  }
  const gliding = new Map<HTMLElement, Glide>();

  // The glide is a critically damped spring pulling the panel towards the
  // position it is being synced to — a curve with a *velocity*, not a
  // position curve replayed from the top.
  //
  // Both halves of that matter, and the second one is why the obvious
  // simpler options were rejected after measuring them:
  //
  //   - A fixed-duration ease has a phase, so re-aiming it means restarting
  //     it, and a restart re-enters the curve at its fast part — a velocity
  //     discontinuity at every one of the many re-aims a live scroll causes.
  //   - An exponential ease (`pos += remaining * (1 - e^(-dt/τ))`) has no
  //     phase and re-aims continuously, and it was tried here first. It fails
  //     on the other half: its velocity is *highest at the start*, so a
  //     mirrored panel that has been sitting still moves a quarter of the way
  //     in its very first frame. Measured at τ=55ms: a 280px step covered
  //     73px in one frame, which reads as the same jump this is meant to
  //     replace, just with a tail on it.
  //
  // A spring starts from rest and accelerates, so the panel eases out of
  // stillness rather than leaping out of it; and because its state is a
  // position *and* a velocity, a new goal is absorbed without any
  // discontinuity — the panel simply curves towards the new one from
  // whatever it was already doing. Critically damped (rather than under-)
  // because the panel must never sail past the position it is aligning to;
  // see the guard in `step`, which enforces that outright rather than
  // trusting the curve.
  //
  // Sized against what the mirrored panel actually has to cover. It aligns by
  // sentence, so it does not track the source continuously: it sits still and
  // then moves a whole sentence at once — measured at 44px to 112px a step,
  // a step arriving every 100–500ms depending on which panel is leading. The
  // settle time has to be short enough that a step finishes before the next
  // arrives (or the panel trails a whole sentence behind, which reads as
  // rubber-banding) and long enough to read as travel rather than as a jump.
  const GLIDE_SETTLE_MS = 220;
  // A critically damped spring is within ~2% of its goal at ωt ≈ 5.8, which
  // is what "settled" means above.
  const GLIDE_OMEGA = 5.8 / (GLIDE_SETTLE_MS / 1000);

  // Below this much left to cover, go straight to the goal instead of easing
  // the rest of the way. A spring only approaches its goal asymptotically, so
  // without a floor the last pixel takes unboundedly many frames — and worse,
  // a sub-pixel step can round to no movement at all, which would leave the
  // panel parked a fraction short of a panel end it is supposed to reach
  // exactly. Also the smallest step the glide will take, so every frame makes
  // real progress and the loop cannot stall.
  const GLIDE_MIN_STEP = 1;

  function sentenceGaps(panel: HTMLElement): HTMLElement[] {
    return Array.from(panel.querySelectorAll<HTMLElement>(".sentence-gap"));
  }

  function leadingIndex(panel: HTMLElement, gaps: HTMLElement[]): number {
    const panelRight = panel.getBoundingClientRect().right;
    let best = 0;
    let bestDist = Infinity;
    gaps.forEach((el, i) => {
      const dist = panelRight - el.getBoundingClientRect().right;
      // The leading sentence is the one whose right edge is at or just past
      // (a small positive `dist`) the panel's own right edge — the closest
      // such candidate, not simply the smallest |dist|, since a sentence
      // that's scrolled *past* (right edge to the panel's right, negative
      // dist) is already fully read and shouldn't be treated as current.
      if (dist >= -2 && dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  // A panel's own natural minimum |scrollLeft| (its most-negative reachable
  // value — vertical-rl's `scrollLeft` runs from 0 at the panel's own right
  // edge, the reading start, down to this at the reading end). Read fresh
  // each time rather than cached, since it changes whenever the tree is
  // re-rendered (a new/edited text).
  function maxScroll(panel: HTMLElement): number {
    return -(panel.scrollWidth - panel.clientWidth);
  }

  // One step of a glide. Every write this module makes goes through here,
  // and every one that *moves the panel* is recorded — there is deliberately
  // no "close enough, don't bother" early return on the requested value,
  // because a write this module makes without recording is precisely the
  // hole the old oscillation came through.
  function writeTarget(target: HTMLElement, value: number): void {
    // Explicitly instant, overriding the `scroll-behavior: smooth` the panel
    // carries in tategaki.css. That declaration is there for the one
    // programmatic scroll that should be animated *by the browser* —
    // `scrollIntoView` onto an inspected character — and must not apply here
    // even though a sync is now animated too, because this module animates a
    // sync itself, one instant write per frame.
    //
    // Handing the animation to the browser instead is what made the panels
    // oscillate at the start of the text, and the difference is not
    // cosmetic. A smooth write emits scroll events for the whole length of
    // its animation, not one, and moves the panel between them — so the
    // panel's live `scrollLeft` at the moment an event is dispatched is some
    // intermediate position that was never written and never recorded. An
    // earlier version compounded this with a sub-pixel early return here: as
    // the user's scroll decelerated into the beginning, its steps fell under
    // that threshold and this function started returning without recording
    // anything, while the target was still animating from a write issued
    // several frames before. Those leftover events matched no recorded
    // write, so each was read as a fresh user scroll and synced *backwards*,
    // dragging the panel the user had just brought to the start back off it
    // by ~50px.
    //
    // Driving the animation here restores the invariant that guard depends
    // on: the panel only ever sits at a position this module put it at, so
    // an event that is this module's own always matches, however late it
    // arrives, and one that does not match really is the user's.
    const before = target.scrollLeft;
    target.scrollTo({ left: value, behavior: "instant" });
    // Only a write that actually moved the panel gets recorded, so a slot is
    // occupied exactly when a 'scroll' event is on its way to claim it.
    //
    // The comment on `written` says a stale entry is harmless because it is a
    // position that never comes back. That is true in the middle of the text
    // and false at either end, which is where this module writes most often:
    // ask a panel already at its own maximum to go to its maximum and it
    // stays put and fires nothing, leaving an entry parked on the one
    // position the *user* is also most likely to arrive at next. Measured:
    // the panels ended a sync 65px — one whole sentence — apart, because the
    // user's scroll onto the end of the kakikudashi panel landed on exactly
    // that stale value, was taken for this module's own write, and never
    // synced the kundoku panel to the end at all.
    if (target.scrollLeft !== before) written.set(target, target.scrollLeft);
  }

  // Abandon whatever this module was moving `panel` towards. Called when the
  // user takes that same panel somewhere themselves: the goal was computed
  // from a position the panel is no longer at, so continuing to ease towards
  // it would drag the panel back out from under them.
  function stopGlide(panel: HTMLElement): void {
    const glide = gliding.get(panel);
    if (glide === undefined) return;
    cancelAnimationFrame(glide.frame);
    gliding.delete(panel);
  }

  function glideTarget(target: HTMLElement, goal: number): void {
    const existing = gliding.get(target);
    if (existing !== undefined) {
      // Supersede rather than queue: the panel is being aimed at where the
      // source is *now*, and every position it was aimed at on the way here
      // is already out of date. Only the goal changes — the glide keeps its
      // current speed and curves towards the new one from wherever it is.
      //
      // Ignoring a sub-pixel change of goal here was tried, to stop a goal
      // wandering a fraction backwards when the browser rounds a write and
      // the next sync computes from where the panel actually landed. It made
      // the reversal worse, not better (measured 0–1px before, 1–8px after):
      // a scroll produces many sub-pixel updates, and dropping them all makes
      // the goal lag and then arrive as one accumulated jump.
      existing.goal = goal;
      return;
    }
    if (Math.abs(target.scrollLeft - goal) < GLIDE_MIN_STEP) return;

    const glide: Glide = { goal, velocity: 0, frame: 0, last: performance.now() };

    function step(now: number): void {
      // `dt` capped, so a frame the browser delayed (a background tab, a
      // long parse on the main thread) resumes the glide rather than
      // covering the whole remaining distance in the one frame that follows.
      const dt = Math.min(now - glide.last, 50) / 1000;
      glide.last = now;

      // Read where the panel *is* rather than carrying an internal position:
      // whatever the browser clamped or rounded the last write to is the
      // truth, and integrating from it keeps the spring from accumulating a
      // drift against it.
      const from = target.scrollLeft;
      const remaining = glide.goal - from;
      if (Math.abs(remaining) <= GLIDE_MIN_STEP) {
        writeTarget(target, glide.goal);
        gliding.delete(target);
        return;
      }

      // Critically damped spring integrated *implicitly* — solving for the
      // end-of-frame velocity rather than stepping forward on the
      // start-of-frame one. Explicit integration of a spring this stiff (ω of
      // ~26 rad/s against a 16ms frame) is only conditionally stable and
      // rings or diverges outright when a frame runs long; the implicit form
      // is unconditionally stable and errs towards *more* damping, which is
      // the safe direction here.
      const w = GLIDE_OMEGA;
      const f = 1 + 2 * dt * w;
      const hoo = dt * w * w;
      const hhoo = dt * hoo;
      const det = f + hhoo;
      let advance = (f * from + dt * glide.velocity + hhoo * glide.goal) / det - from;
      glide.velocity = (glide.velocity + hoo * remaining) / det;

      // Never past the goal. A critically damped spring does not oscillate,
      // but it can still cross its equilibrium once if it arrives carrying
      // enough speed — and a single crossing is exactly the reversal this
      // module exists to not have. Stopping it at the goal costs nothing
      // visible (the panel was within a frame of arriving) and makes "the
      // mirrored panel never moves away from where it is heading" a property
      // of the code rather than of the tuning.
      if (Math.abs(advance) > Math.abs(remaining)) {
        advance = remaining;
        glide.velocity = 0;
      } else if (Math.abs(advance) < GLIDE_MIN_STEP) {
        advance = Math.sign(remaining) * GLIDE_MIN_STEP;
      }
      writeTarget(target, from + advance);

      // The panel did not move although a whole pixel was asked for, so it is
      // against one of its own ends and the goal is past it — the browser
      // clamped the write. Stop, rather than spend every remaining frame
      // asking for a position that cannot be reached.
      if (Math.abs(target.scrollLeft - from) < GLIDE_MIN_STEP / 4) {
        gliding.delete(target);
        return;
      }
      glide.frame = requestAnimationFrame(step);
    }

    gliding.set(target, glide);
    glide.frame = requestAnimationFrame(step);
  }

  // A panel's column grid: the pitch from one column to the next, and the
  // screen x its first column's right edge sits at.
  //
  // The pitch is read as the resolved `line-height` of the element the text
  // is set on, which is what a column's width *is* under vertical-rl (the
  // block axis is the horizontal one, so a line box is `line-height` across).
  // Reading it rather than naming a number keeps this tracking the type scale
  // — `--column-pitch` and `--column-pitch-kakikudashi` in typography.css are
  // where the 2:1 relation is declared, and where a change to it would be
  // made.
  //
  // The origin is the panel's content-box right edge, because vertical-rl
  // starts its block progression there: the first column's right edge is at
  // it exactly, and every other column's is a whole number of pitches to its
  // left. Confirmed by measurement, at a 44px type size: the kundoku panel's
  // column right edges came out at 521.6, 433.6, 345.6, … — its content-box
  // right edge, then 88px steps — and the kakikudashi panel's at the same
  // 521.6 in 44px steps.
  function columnGrid(panel: HTMLElement): { pitch: number; origin: number } | null {
    const first = panel.firstElementChild;
    if (first === null) return null;
    const pitch = parseFloat(getComputedStyle(first).lineHeight);
    if (!(pitch > 0)) return null;
    const style = getComputedStyle(panel);
    const origin =
      panel.getBoundingClientRect().right -
      parseFloat(style.borderRightWidth) -
      parseFloat(style.paddingRight);
    return { pitch, origin };
  }

  /** The position nearest `want` at which the two panels' columns fall on
   * common boundaries — two kakikudashi columns to one kundoku column, the
   * ratio typography.css sets them at.
   *
   * A column boundary of a panel sits at `origin - scrollLeft - n * pitch`.
   * For one of each panel's to coincide, with pitches P and 2P, the two
   * `origin - scrollLeft` have to agree modulo the *finer* pitch — the
   * coarser panel's boundaries then land on every second one of the finer
   * panel's, which is the 2:1 relation. So the target has a lattice of
   * admissible positions, spaced one fine pitch apart, and the per-sentence
   * alignment above picks which of them by handing this the position it
   * wants; this only rounds that to the nearest lattice point, moving the
   * panel by at most half a pitch.
   *
   * The lattice moves with the source, and that is the whole difficulty. A
   * panel scrolling steadily through one sentence passes a lattice point
   * every `pitch` pixels, so the admissible position nearest a *fixed* `want`
   * walks along with it and then wraps a whole pitch backwards — a sawtooth,
   * and every tooth of it a reversal. Measured with the snap taken
   * unconditionally: driving the kakikudashi panel to the start reversed the
   * mirrored kundoku panel by 932px and dragged the driven panel itself back
   * 467px, which is the old oscillation in full. The other three directions
   * survived only because the glide smoothed the teeth down to ~1.5px of
   * chatter.
   *
   * This is not a tuning problem, it is arithmetic: the two panels are 1177px
   * and 473px long here, so a mirror that stayed exactly on the lattice at
   * every instant would have to travel at the source's own speed and take
   * ~16 backward corrections of a whole pitch on the way. Exact coincidence
   * *at every instant* and never moving backwards cannot both hold.
   *
   * So the snap yields where they collide: it may move the panel, but never
   * to the far side of where the panel already is or is already heading. It
   * therefore lands exactly on the lattice whenever the two agree — which is
   * at every sentence boundary, where this is recomputed against a fresh
   * `want` — and holds the sentence alignment unsnapped in the sawtooth's
   * backward phase rather than lurching.
   *
   * `headroom` is how far the panel may be moved back towards the start
   * before the sentence *before* this one would become the leading one
   * instead; see the caller. Rounding always goes that way and never the
   * other, because `want` puts the leading sentence's edge exactly on the
   * panel's edge: nudge the panel one pixel further into the text and that
   * sentence is scrolled past, so the two panels stop showing the same one.
   * Rounding to the nearest lattice point rather than the one behind was
   * tried and is what makes the difference — measured over 20 rest positions,
   * the two panels agreed on the leading sentence 8 times out of 20 with
   * nearest-rounding. */
  function snapToColumnGrid(
    source: HTMLElement,
    target: HTMLElement,
    want: number,
    headroom: number,
  ): number {
    const sourceGrid = columnGrid(source);
    const targetGrid = columnGrid(target);
    if (sourceGrid === null || targetGrid === null) return want;
    const pitch = Math.min(sourceGrid.pitch, targetGrid.pitch);
    // Where the lattice sits: the residue the target's scrollLeft must have
    // for its columns to line up with the source's, given where the source
    // is now. `scrollLeft` runs negative here, so the lattice point *behind*
    // `want` — towards the start of the text — is the next one up.
    const phase = source.scrollLeft - sourceGrid.origin + targetGrid.origin;
    let snapped = phase + Math.ceil((want - phase) / pitch) * pitch;
    // A lattice point can fall outside the panel's own range; take the
    // outermost one that does not. `low` is the panel's own end, 0 its start.
    const low = maxScroll(target);
    if (snapped > 0) snapped = phase + Math.floor(-phase / pitch) * pitch;
    else if (snapped < low) snapped = phase + Math.ceil((low - phase) / pitch) * pitch;
    // Unsnapped when there is no lattice point this panel can actually sit on
    // — its whole range narrower than one pitch — and when the nearest one
    // behind is further back than the previous sentence, where taking it
    // would swap which sentence leads. The sentence alignment is the older
    // requirement and wins outright in both cases; the panels then simply
    // read as they did before the ratio was asked for.
    const reachable = snapped <= 0 && snapped >= low;
    const candidate = reachable && snapped - want <= headroom ? snapped : want;

    // Where the panel already is, or has already been told to go — the
    // position the sentence alignment is moving it *away* from.
    const inFlight = gliding.get(target);
    const from = inFlight === undefined ? target.scrollLeft : inFlight.goal;
    // Never back past that. When the sawtooth wraps, the nearest lattice
    // point lands behind where the panel is already headed; holding the
    // position it is already headed to is what makes the sequence of goals
    // monotone, and a monotone sequence of goals is what makes the reversal
    // zero. Held or snapped, the result stays within `headroom` of `want`,
    // since both `from` and `snapped` are.
    //
    // Every path out of this function goes through the clamp, the unsnapped
    // fallback above included. Letting that one path return `want` directly
    // was tried and measured: `want` and `snapped` are up to half a pitch
    // apart, so where the fallback and the snap alternated — which is around
    // the panel's own ends, where a lattice point falls out of range — the
    // goal itself moved back and forth, and 1–3.5px of that survived the
    // glide's smoothing and showed up as reversal.
    if (want === from) return from;
    return want < from ? Math.min(from, candidate) : Math.max(from, candidate);
  }

  function sync(source: HTMLElement, target: HTMLElement): void {
    const sourceGaps = sentenceGaps(source);
    const targetGaps = sentenceGaps(target);
    if (sourceGaps.length === 0 || sourceGaps.length !== targetGaps.length) return;

    // "Start" and "end" are *absolute* concepts (scrollLeft 0, or this
    // panel's own natural maximum magnitude) — not per-sentence-relative
    // ones the general alignment below can express, since neither panel
    // has any content *before* the first sentence or *after* the last to
    // measure an inter-panel offset against. Each panel's own padding/
    // margin at these two edges is independent of the other's (confirmed
    // by measurement: at both panels' own true, unsynced starting
    // scrollLeft of 0, the two `.tategaki`'s own natural insets from panel
    // edge to first `.sentence-gap` differ) — snapping target to *its own*
    // 0/max here, rather than deriving a target position from source's
    // inset the way the per-sentence branch below does, is what makes
    // "source scrolled all the way to its start" reliably reach target's
    // start too instead of stopping wherever source's own inset happens to
    // land on target's geometry.
    if (source.scrollLeft >= -1) {
      glideTarget(target, 0);
      return;
    }
    if (source.scrollLeft <= maxScroll(source) + 1) {
      glideTarget(target, maxScroll(target));
      return;
    }

    const index = leadingIndex(source, sourceGaps);
    const targetEl = targetGaps[index];
    // Both terms are read *now*, and the position they give is absolute: the
    // gap's rectangle already accounts for wherever the glide has got the
    // target to this frame, so `scrollLeft - delta` is the same answer
    // whenever during a glide it is asked. Re-aiming an in-flight glide with
    // it is therefore safe — it is not a relative nudge that would compound.
    const delta = target.getBoundingClientRect().right - targetEl.getBoundingClientRect().right;
    const want = target.scrollLeft - delta;

    // How far back towards the start of the text the column snap may move the
    // panel from there before the *previous* sentence would take over as the
    // leading one — which is how far the previous sentence's own edge sits
    // from this one's, since `want` puts this one's edge on the panel's edge
    // and moving back carries both leftward together. The first sentence has
    // nothing before it to lose the lead to, so it can go as far as it likes.
    const previous = targetGaps[index - 1];
    const headroom =
      previous === undefined
        ? Infinity
        : previous.getBoundingClientRect().right - targetEl.getBoundingClientRect().right;

    glideTarget(target, snapToColumnGrid(source, target, want, headroom));
  }

  function onScroll(panel: HTMLElement, other: HTMLElement): void {
    const ours = written.get(panel);
    if (ours !== undefined && Math.abs(panel.scrollLeft - ours) < 1) {
      written.delete(panel);
      return;
    }
    // Not one of this module's own writes, so it is the user scrolling this
    // panel — which supersedes any glide this module still had running *on
    // this panel*. Dropping it here is what keeps an interruption from
    // becoming a fight: without this the two would each keep pulling, the
    // user's panel towards the stale goal and the other towards the user.
    stopGlide(panel);
    sync(panel, other);
  }

  panelA.addEventListener("scroll", () => onScroll(panelA, panelB));
  panelB.addEventListener("scroll", () => onScroll(panelB, panelA));
}
