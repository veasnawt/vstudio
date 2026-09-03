/** The registry of bundled sound effects the SFX panel (`SfxPanel.tsx`) lists and previews — mirrors
 *  `fonts.ts`'s `FONT_REGISTRY` shape (one flat array of small, self-describing entries, keyed by a
 *  stable `id`), but for a much simpler problem: a font needs several real files per family (one per
 *  weight/style FFmpeg's `drawtext` can point at) and gets read by two different renderers, while an
 *  SFX clip is just one short audio file a user previews and drops onto an audio track — no export-time
 *  code path ever reads this registry at all (see `sfxAssetUrl`'s own comment in `api/client.ts`).
 *
 *  Deliberately NO `sfxById`-with-fallback the way `fontById` has one: `fontById`'s leniency exists
 *  because a font id gets PERSISTED into `project.json` (`TextStyle.fontId`), so a project saved by a
 *  newer build (or one that later drops a font) must still open in an older/changed build without
 *  throwing. An SFX id is never persisted anywhere — picking an entry here just fetches its bundled
 *  file and runs it through the ordinary import pipeline (see `SfxPanel.tsx`'s "Add" handler), after
 *  which it's a completely normal `Asset`/`Clip` like any dragged-in audio file, with no further
 *  reference back to this registry or its ids. There is nothing left for an "unknown id" to mean once
 *  that hand-off happens, so there's nothing here worth being lenient about. */

export interface SfxDefinition {
  id: string;
  /** Shown in the SFX panel's list. */
  label: string;
  /** Groups entries into the panel's sections — plain UI grouping, never persisted or read back.
   *  `"Meme"` was added alongside a ~150-file bulk import (reaction/pop-culture/social-media clips —
   *  see the "Imported batch" comments below) that doesn't fit any of the original six curated
   *  buckets; `SfxPanel.tsx`'s own search box (added the same time) is the PRIMARY way to find one of
   *  these in practice, not browsing the category — 90 flatly-listed "Meme" entries would be a wall of
   *  text otherwise. */
  category: "UI" | "Whoosh" | "Impact" | "Riser" | "Chime" | "Ambience" | "Meme";
  /** Filename within `packages/vcut/assets/sfx/` — never a path, matching `FontVariantFiles.regular`'s
   *  own reasoning: no ambiguity between the dev filesystem location and the packaged app's (see the
   *  vcut app's `_lib/sfx.ts` `resolveSfxDir`). */
  file: string;
}

export const SFX_REGISTRY: SfxDefinition[] = [
  // UI — short, functional cues for clicks/taps/notifications inside a video (a fake-UI mockup, an
  // app-demo overlay), not the editor's own chrome.
  { id: "click-soft", label: "Click (Soft)", category: "UI", file: "click-soft.mp3" },
  { id: "click-firm", label: "Click (Firm)", category: "UI", file: "click-firm.mp3" },
  { id: "pop", label: "Pop", category: "UI", file: "pop.mp3" },
  { id: "notification", label: "Notification", category: "UI", file: "notification.mp3" },

  // --- Imported batch: UI (27) — clicks/typing/message/app-notification sounds pulled from the bulk
  // meme/SFX import (see `SfxDefinition["category"]`'s own doc comment on why "Meme" exists). Labels
  // are cleaned-up versions of the original download filenames, not independently verified per-sound
  // descriptions.
  { id: "facebook-message", label: "Facebook Message", category: "UI", file: "facebook-message.mp3" },
  { id: "announcement-chime", label: "Announcement Chime", category: "UI", file: "announcement-chime.mp3" },
  { id: "apple-pay", label: "Apple Pay Chime", category: "UI", file: "apple-pay.mp3" },
  { id: "camera-flash", label: "Camera Flash", category: "UI", file: "camera-flash.mp3" },
  { id: "camera-shutter-1", label: "Camera Shutter 1", category: "UI", file: "camera-shutter-1.mp3" },
  { id: "camera-shutter-2", label: "Camera Shutter 2", category: "UI", file: "camera-shutter-2.mp3" },
  { id: "checkmark-ding", label: "Checkmark Ding", category: "UI", file: "checkmark-ding.mp3" },
  { id: "click-generic", label: "Click (Generic)", category: "UI", file: "click-generic.mp3" },
  { id: "ding-alt", label: "Ding (Alt)", category: "UI", file: "ding-alt.mp3" },
  { id: "discord-leave", label: "Discord Leave", category: "UI", file: "discord-leave.mp3" },
  { id: "discord-notification", label: "Discord Notification", category: "UI", file: "discord-notification.mp3" },
  { id: "error-glitch", label: "Error Glitch", category: "UI", file: "error-glitch.mp3" },
  { id: "keyboard-click", label: "Keyboard Click", category: "UI", file: "keyboard-click.mp3" },
  { id: "keyboard-typing", label: "Keyboard Typing", category: "UI", file: "keyboard-typing.mp3" },
  { id: "mouse-click-1", label: "Mouse Click 1", category: "UI", file: "mouse-click-1.mp3" },
  { id: "mouse-click-2", label: "Mouse Click 2", category: "UI", file: "mouse-click-2.mp3" },
  { id: "new-follower", label: "New Follower", category: "UI", file: "new-follower.mp3" },
  { id: "psn-notification", label: "PSN Notification", category: "UI", file: "psn-notification.mp3" },
  { id: "quick-ting", label: "Quick Ting", category: "UI", file: "quick-ting.mp3" },
  { id: "message-sent", label: "Message Sent", category: "UI", file: "message-sent.mp3" },
  { id: "snapchat-message", label: "Snapchat Message", category: "UI", file: "snapchat-message.mp3" },
  { id: "sonic-error", label: "Sonic Error", category: "UI", file: "sonic-error.mp3" },
  { id: "tv-error", label: "TV Error", category: "UI", file: "tv-error.mp3" },
  { id: "typing-alt", label: "Typing (Alt)", category: "UI", file: "typing-alt.mp3" },
  { id: "whatsapp-voice-note", label: "WhatsApp Voice Note", category: "UI", file: "whatsapp-voice-note.mp3" },
  { id: "whatsapp-typing", label: "WhatsApp Typing", category: "UI", file: "whatsapp-typing.mp3" },
  { id: "wrong-buzzer", label: "Wrong Buzzer", category: "UI", file: "wrong-buzzer.mp3" },

  // Whoosh — transition/movement swishes, the kind used under a cut or a fast pan. The four
  // "Whoosh (<Transition family>)" entries below each pair with one of `TRANSITION_TYPE_OPTIONS`'s own
  // four families (`transitions.ts`) — a smooth, lowpass-muffled swell for the slow blend of
  // crossfade/dissolve; a short, highpass-bright swipe for the four directional wipes; a broader
  // mid-bright glide, longer than the wipe sound, for the four slides; and a rising sine "boop" sweep
  // (not noise-based at all, so it reads as a distinct circular OPENING gesture rather than another
  // swipe) for circleOpen/circleClose. Synthesized with ffmpeg's own `anoisesrc`/`aevalsrc` filters
  // (confirmed via `showspectrumpic` before bundling — the same reason this app's OWN test/demo assets
  // get built that way, not recorded), matching the character/length of the two pre-existing generic
  // whoosh sounds just below, kept as-is since they're still perfectly good general-purpose picks.
  { id: "whoosh-dissolve", label: "Whoosh (Dissolve)", category: "Whoosh", file: "whoosh-dissolve.mp3" },
  { id: "whoosh-wipe", label: "Whoosh (Wipe)", category: "Whoosh", file: "whoosh-wipe.mp3" },
  { id: "whoosh-slide", label: "Whoosh (Slide)", category: "Whoosh", file: "whoosh-slide.mp3" },
  { id: "whoosh-circle", label: "Whoosh (Circle)", category: "Whoosh", file: "whoosh-circle.mp3" },
  { id: "whoosh-fast", label: "Whoosh (Fast)", category: "Whoosh", file: "whoosh-fast.mp3" },
  { id: "swoosh-soft", label: "Swoosh (Soft)", category: "Whoosh", file: "swoosh-soft.mp3" },
  { id: "whoosh-generic", label: "Whoosh (Generic)", category: "Whoosh", file: "whoosh-generic.mp3" },

  // Impact — hits/thuds for emphasis on a cut, a title landing, or an on-screen action.
  { id: "impact-thud", label: "Impact (Thud)", category: "Impact", file: "impact-thud.mp3" },
  { id: "impact-hit", label: "Impact (Hit)", category: "Impact", file: "impact-hit.mp3" },
  { id: "bone-crack", label: "Bone Crack", category: "Impact", file: "bone-crack.mp3" },
  { id: "broken-glass-hq", label: "Broken Glass (HQ)", category: "Impact", file: "broken-glass-hq.mp3" },
  { id: "car-crash", label: "Car Crash", category: "Impact", file: "car-crash.mp3" },
  { id: "glass-break", label: "Glass Break", category: "Impact", file: "glass-break.mp3" },
  { id: "gun-reload", label: "Gun Reload", category: "Impact", file: "gun-reload.mp3" },
  { id: "metal-pipe-clang", label: "Metal Pipe Clang", category: "Impact", file: "metal-pipe-clang.mp3" },
  { id: "paper-ripping", label: "Paper Ripping", category: "Impact", file: "paper-ripping.mp3" },
  { id: "pump-shotgun-fortnite", label: "Pump Shotgun (Fortnite)", category: "Impact", file: "pump-shotgun-fortnite.mp3" },
  { id: "punch", label: "Punch", category: "Impact", file: "punch.mp3" },
  { id: "punching", label: "Punching", category: "Impact", file: "punching.mp3" },
  { id: "slap-1", label: "Slap 1", category: "Impact", file: "slap-1.mp3" },
  { id: "slap-2", label: "Slap 2", category: "Impact", file: "slap-2.mp3" },
  { id: "slap-3", label: "Slap 3", category: "Impact", file: "slap-3.mp3" },
  { id: "weak-punch", label: "Weak Punch", category: "Impact", file: "weak-punch.mp3" },

  // Riser — a single rising-tension sweep, built to lead INTO a cut/reveal rather than sit under one.
  { id: "riser-tension", label: "Riser (Tension)", category: "Riser", file: "riser-tension.mp3" },
  { id: "panic-suspense", label: "Panic Suspense", category: "Riser", file: "panic-suspense.mp3" },
  { id: "suspense-strike", label: "Suspense Strike", category: "Riser", file: "suspense-strike.mp3" },
  { id: "sudden-suspense", label: "Sudden Suspense", category: "Riser", file: "sudden-suspense.mp3" },

  // Chime — pleasant bell/ding tones for a positive beat (a checkmark, a "success" moment, a reveal).
  { id: "chime-bell", label: "Chime (Bell)", category: "Chime", file: "chime-bell.mp3" },
  { id: "ding-short", label: "Ding (Short)", category: "Chime", file: "ding-short.mp3" },

  // Ambience — a longer, low-level bed rather than a one-shot hit; meant to be trimmed to length once
  // placed, the same as any other imported audio clip.
  { id: "ambience-room-tone", label: "Ambience (Room Tone)", category: "Ambience", file: "ambience-room-tone.mp3" },
  { id: "background-music", label: "Background Music", category: "Ambience", file: "background-music.mp3" },
  { id: "bird-chirping", label: "Bird Chirping", category: "Ambience", file: "bird-chirping.mp3" },
  { id: "clock-tick", label: "Clock Tick", category: "Ambience", file: "clock-tick.mp3" },
  { id: "cow-moo", label: "Cow Moo", category: "Ambience", file: "cow-moo.mp3" },
  { id: "crickets-chirping", label: "Crickets Chirping", category: "Ambience", file: "crickets-chirping.mp3" },
  { id: "dolphin", label: "Dolphin", category: "Ambience", file: "dolphin.mp3" },
  { id: "goat", label: "Goat", category: "Ambience", file: "goat.mp3" },
  { id: "meow", label: "Meow", category: "Ambience", file: "meow.mp3" },
  { id: "elevator-music-short", label: "Elevator Music (Short)", category: "Ambience", file: "elevator-music-short.mp3" },
  { id: "shark-swimming", label: "Shark Swimming (Fast)", category: "Ambience", file: "shark-swimming.mp3" },
  { id: "walking-footsteps", label: "Walking Footsteps", category: "Ambience", file: "walking-footsteps.mp3" },
  { id: "water-droplet-drip", label: "Water Droplet Drip", category: "Ambience", file: "water-droplet-drip.mp3" },

  // Meme — reaction cues, pop-culture stings, and social-media/meme-format sounds. Far larger and
  // more heterogeneous than the six curated categories above (see `SfxDefinition["category"]`'s own
  // doc comment) — `SfxPanel.tsx`'s search box, not this category list, is the intended way to find
  // one of these.
  { id: "sound-67", label: "Sound 67", category: "Meme", file: "sound-67.mp3" },
  { id: "social-credit-siren", label: "Social Credit Siren", category: "Meme", file: "social-credit-siren.mp3" },
  { id: "aaaa-scream", label: "AAAAAAAA Scream", category: "Meme", file: "aaaa-scream.mp3" },
  { id: "inception-horn", label: "Inception Horn", category: "Meme", file: "inception-horn.mp3" },
  { id: "few-moments-later-spongebob", label: "A Few Moments Later (SpongeBob)", category: "Meme", file: "few-moments-later-spongebob.mp3" },
  { id: "ad-jingle", label: "Ad Jingle", category: "Meme", file: "ad-jingle.mp3" },
  { id: "among-us-role-reveal", label: "Among Us Role Reveal", category: "Meme", file: "among-us-role-reveal.mp3" },
  { id: "angry-grunt", label: "Angry Grunt", category: "Meme", file: "angry-grunt.mp3" },
  { id: "anime-wow", label: "Anime Wow", category: "Meme", file: "anime-wow.mp3" },
  { id: "another-one", label: "Another One (DJ Khaled)", category: "Meme", file: "another-one.mp3" },
  { id: "applause", label: "Applause", category: "Meme", file: "applause.mp3" },
  { id: "sound-misc-1", label: "Misc Sound 1", category: "Meme", file: "sound-misc-1.mp3" },
  { id: "awolnation-run", label: "AWOLNATION - Run (Clip)", category: "Meme", file: "awolnation-run.mp3" },
  { id: "batman-transition", label: "Batman Transition (Comical)", category: "Meme", file: "batman-transition.mp3" },
  { id: "phone-cannot-be-reached", label: "Phone Cannot Be Reached (Khmer)", category: "Meme", file: "phone-cannot-be-reached.mp3" },
  { id: "booyooy", label: "Booyooy", category: "Meme", file: "booyooy.mp3" },
  { id: "brain-trust", label: "Brain Trust (Wayne Jones)", category: "Meme", file: "brain-trust.mp3" },
  { id: "bruh", label: "Bruh", category: "Meme", file: "bruh.mp3" },
  { id: "cartoon-slip", label: "Cartoon Slip", category: "Meme", file: "cartoon-slip.mp3" },
  { id: "cat-laugh", label: "Cat Laugh", category: "Meme", file: "cat-laugh.mp3" },
  { id: "ceeday-huh", label: "Huh? (Ceeday)", category: "Meme", file: "ceeday-huh.mp3" },
  { id: "coughing", label: "Coughing", category: "Meme", file: "coughing.mp3" },
  { id: "csgo-okay-lets-go", label: "Okay Let's Go! (CS:GO)", category: "Meme", file: "csgo-okay-lets-go.mp3" },
  { id: "curb-your-enthusiasm", label: "Curb Your Enthusiasm Theme", category: "Meme", file: "curb-your-enthusiasm.mp3" },
  { id: "dial-up-internet", label: "Dial-Up Internet", category: "Meme", file: "dial-up-internet.mp3" },
  { id: "dj-stop", label: "DJ Stop (Record Scratch)", category: "Meme", file: "dj-stop.mp3" },
  { id: "duck-toy", label: "Duck Toy", category: "Meme", file: "duck-toy.mp3" },
  { id: "emotional-damage", label: "Emotional Damage", category: "Meme", file: "emotional-damage.mp3" },
  { id: "engineer-voice", label: "Engineer Voice Line", category: "Meme", file: "engineer-voice.mp3" },
  { id: "faaah", label: "Faaah", category: "Meme", file: "faaah.mp3" },
  { id: "fart-reverb", label: "Fart (With Reverb)", category: "Meme", file: "fart-reverb.mp3" },
  { id: "funny-laughing", label: "Funny Laughing", category: "Meme", file: "funny-laughing.mp3" },
  { id: "echo-voice-tiktok", label: "Echo Voice (TikTok)", category: "Meme", file: "echo-voice-tiktok.mp3" },
  { id: "get-out", label: "Get Out!", category: "Meme", file: "get-out.mp3" },
  { id: "gopgopgop", label: "Gopgopgop", category: "Meme", file: "gopgopgop.mp3" },
  { id: "gta-v-wasted-busted", label: "GTA V Wasted/Busted", category: "Meme", file: "gta-v-wasted-busted.mp3" },
  { id: "hah-meme", label: "Hah", category: "Meme", file: "hah-meme.mp3" },
  { id: "hahahaha", label: "Hahahaha", category: "Meme", file: "hahahaha.mp3" },
  { id: "happy-happy-happy-cat", label: "Happy Happy Happy Cat", category: "Meme", file: "happy-happy-happy-cat.mp3" },
  { id: "he-knew-he-messed-up", label: "He Knew He Messed Up", category: "Meme", file: "he-knew-he-messed-up.mp3" },
  { id: "john-pork-calling", label: "John Pork Is Calling", category: "Meme", file: "john-pork-calling.mp3" },
  { id: "kids-saying-yay", label: "Kids Saying Yay", category: "Meme", file: "kids-saying-yay.mp3" },
  { id: "kids-cheering", label: "Kids Cheering", category: "Meme", file: "kids-cheering.mp3" },
  { id: "kimi-no-toriko", label: "Kimi no Toriko", category: "Meme", file: "kimi-no-toriko.mp3" },
  { id: "laughing-dung-cuoi", label: "Laughing (Dung Cười)", category: "Meme", file: "laughing-dung-cuoi.mp3" },
  { id: "mario-coin", label: "Mario Coin", category: "Meme", file: "mario-coin.mp3" },
  { id: "mario-death", label: "Mario Death", category: "Meme", file: "mario-death.mp3" },
  { id: "math-meme", label: "Math Meme", category: "Meme", file: "math-meme.mp3" },
  { id: "meccha-chameleon-whistle", label: "Meccha Chameleon Whistle", category: "Meme", file: "meccha-chameleon-whistle.mp3" },
  { id: "end-credits-meme", label: "End Credits Meme", category: "Meme", file: "end-credits-meme.mp3" },
  { id: "sad-violin-meme-edit", label: "Sad Violin (Meme Edit)", category: "Meme", file: "sad-violin-meme-edit.mp3" },
  { id: "metal-gear-alert", label: "Metal Gear Alert", category: "Meme", file: "metal-gear-alert.mp3" },
  { id: "mgs-snake-death-scream", label: "Metal Gear Solid Death Scream", category: "Meme", file: "mgs-snake-death-scream.mp3" },
  { id: "minecraft-eating", label: "Minecraft Eating", category: "Meme", file: "minecraft-eating.mp3" },
  { id: "nani-meme", label: "Nani?!", category: "Meme", file: "nani-meme.mp3" },
  { id: "nioce", label: "Nioce", category: "Meme", file: "nioce.mp3" },
  { id: "noice-meme", label: "Noice", category: "Meme", file: "noice-meme.mp3" },
  { id: "ocean-meme", label: "Ocean Meme", category: "Meme", file: "ocean-meme.mp3" },
  { id: "oh-ma-gaud", label: "Oh Ma Gaud (Vine)", category: "Meme", file: "oh-ma-gaud.mp3" },
  { id: "oh-my-god-anime", label: "Oh My God (Anime)", category: "Meme", file: "oh-my-god-anime.mp3" },
  { id: "ohh", label: "Ohh", category: "Meme", file: "ohh.mp3" },
  { id: "oi", label: "Oi", category: "Meme", file: "oi.mp3" },
  { id: "people-laughing", label: "People Laughing", category: "Meme", file: "people-laughing.mp3" },
  { id: "pew-pew-lame", label: "Pew Pew (Lame)", category: "Meme", file: "pew-pew-lame.mp3" },
  { id: "preview-sound", label: "Preview Sound", category: "Meme", file: "preview-sound.mp3" },
  { id: "remix-funny-sounds-2", label: "Remix Funny Sounds 2", category: "Meme", file: "remix-funny-sounds-2.mp3" },
  { id: "remix-funny-sounds-1", label: "Remix Funny Sounds 1", category: "Meme", file: "remix-funny-sounds-1.mp3" },
  { id: "roblox-oof", label: "Roblox Death (Oof)", category: "Meme", file: "roblox-oof.mp3" },
  { id: "romance", label: "Romanceeee", category: "Meme", file: "romance.mp3" },
  { id: "sad-violin-classic", label: "Sad Violin (Classic)", category: "Meme", file: "sad-violin-classic.mp3" },
  { id: "sad-trombone", label: "Sad Trombone", category: "Meme", file: "sad-trombone.mp3" },
  { id: "scheming-weasel", label: "Scheming Weasel (Faster)", category: "Meme", file: "scheming-weasel.mp3" },
  { id: "sequence-01", label: "Sequence 01", category: "Meme", file: "sequence-01.mp3" },
  { id: "smooch-kiss", label: "Smooch Kiss", category: "Meme", file: "smooch-kiss.mp3" },
  { id: "spongebob-two-hours-later", label: "Two Hours Later (SpongeBob)", category: "Meme", file: "spongebob-two-hours-later.mp3" },
  { id: "spraying-perfume", label: "Spraying Perfume", category: "Meme", file: "spraying-perfume.mp3" },
  { id: "take-off", label: "Take Off", category: "Meme", file: "take-off.mp3" },
  { id: "tiktok-china-sound-2", label: "TikTok China Sound 2", category: "Meme", file: "tiktok-china-sound-2.mp3" },
  { id: "tiktok-china-sound-3", label: "TikTok China Sound 3", category: "Meme", file: "tiktok-china-sound-3.mp3" },
  { id: "tiktok-china-sound-1", label: "TikTok China Sound 1", category: "Meme", file: "tiktok-china-sound-1.mp3" },
  { id: "tuturu", label: "Tuturu", category: "Meme", file: "tuturu.mp3" },
  { id: "uff", label: "Uff", category: "Meme", file: "uff.mp3" },
  { id: "uiiiiiiii", label: "Uiiiiiiii", category: "Meme", file: "uiiiiiiii.mp3" },
  { id: "vine-boom", label: "Vine Boom", category: "Meme", file: "vine-boom.mp3" },
  { id: "vlog-oh-no", label: "Oh No (Vlog)", category: "Meme", file: "vlog-oh-no.mp3" },
  { id: "wait-what-the-hell", label: "Wait, What the Hell? (Legend)", category: "Meme", file: "wait-what-the-hell.mp3" },
  { id: "what-wtf", label: "What / WTF", category: "Meme", file: "what-wtf.mp3" },
  { id: "wilhelm-scream", label: "Wilhelm Scream", category: "Meme", file: "wilhelm-scream.mp3" },
  { id: "xoet", label: "Xoet", category: "Meme", file: "xoet.mp3" },
  { id: "yamate-kudesai", label: "Yamete Kudasai", category: "Meme", file: "yamate-kudesai.mp3" },
];

/** Absolute path is never resolved here — this package stays fs-free (see `fonts.ts`'s own precedent);
 *  callers that DO need a real path go through the vcut app's `_lib/sfx.ts`, which mirrors
 *  `ffmpeg.ts`'s `resolveFontsDir`/`textFontPath` for the same packaged-vs-dev directory split. */
export function sfxById(id: string): SfxDefinition | undefined {
  return SFX_REGISTRY.find((s) => s.id === id);
}
