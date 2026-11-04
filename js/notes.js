const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const COLORS = [
  "#d4533a",
  "#e07a32",
  "#e0a33a",
  "#b5b34a",
  "#6aaa5a",
  "#3eae8e",
  "#3a93c9",
  "#5a74d6",
  "#7a64cc",
  "#a85cc4",
  "#c45b90",
  "#d15b66",
];

/** High string on top, the way a chord diagram is drawn. */
export const STRINGS = [
  { label: "e", openMidi: 64 },
  { label: "B", openMidi: 59 },
  { label: "G", openMidi: 55 },
  { label: "D", openMidi: 50 },
  { label: "A", openMidi: 45 },
  { label: "E", openMidi: 40 },
];

export const MAX_FRET = 5;

export function describeMidi(midi) {
  const name = NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return {
    midi,
    name,
    octave,
    label: `${name}${octave}`,
    color: COLORS[((midi % 12) + 12) % 12],
    frequency: 440 * 2 ** ((midi - 69) / 12),
  };
}

export function describeFrequency(frequency) {
  const midiFloat = 69 + 12 * Math.log2(frequency / 440);
  const midi = Math.round(midiFloat);
  const cents = (midiFloat - midi) * 100;
  return { ...describeMidi(midi), cents, frequency };
}

export function buildNotePool() {
  const byMidi = new Map();
  for (const string of STRINGS) {
    for (let fret = 0; fret <= MAX_FRET; fret++) {
      const midi = string.openMidi + fret;
      let note = byMidi.get(midi);
      if (!note) {
        note = { ...describeMidi(midi), positions: [] };
        byMidi.set(midi, note);
      }
      note.positions.push({ string: string.label, fret });
    }
  }
  return [...byMidi.values()].sort((a, b) => a.midi - b.midi);
}
