import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Download, Send, ChevronLeft, ChevronRight, Loader2, X, Copy, Target, Calendar, BookOpen, User, MessageCircle, Flame, ChevronDown, Mountain } from 'lucide-react';

// ============================================================================
// FIT binary encoder (workout files) — field numbers verified against the
// official FIT profile. Produces files Garmin Connect can import manually
// ("Importer" > fichier .fit) as a structured workout.
// ============================================================================

const FIT_EPOCH_OFFSET = 631065600; // seconds between 1970-01-01 and the FIT epoch (1989-12-31)

function crc16(buffer) {
  const table = [
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
  ];
  let crc = 0;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    let tmp = table[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    crc = crc ^ tmp ^ table[byte & 0xF];
    tmp = table[crc & 0xF];
    crc = (crc >> 4) & 0x0FFF;
    crc = crc ^ tmp ^ table[(byte >> 4) & 0xF];
  }
  return crc & 0xFFFF;
}

class ByteWriter {
  constructor() { this.chunks = []; }
  pushBytes(arr) { this.chunks.push(Uint8Array.from(arr)); }
  pushUint8(v) { this.pushBytes([v & 0xFF]); }
  pushUint16(v) { this.pushBytes([v & 0xFF, (v >> 8) & 0xFF]); }
  pushUint32(v) { this.pushBytes([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]); }
  pushString(str, size) {
    const bytes = new Array(size).fill(0);
    for (let i = 0; i < Math.min(str.length, size - 1); i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    this.pushBytes(bytes);
  }
  toUint8Array() {
    let total = 0;
    this.chunks.forEach(c => total += c.length);
    const out = new Uint8Array(total);
    let offset = 0;
    this.chunks.forEach(c => { out.set(c, offset); offset += c.length; });
    return out;
  }
}

const T_ENUM = 0x00, T_UINT16 = 0x84, T_UINT32 = 0x86, T_UINT32Z = 0x8C, T_STRING = 0x07;

function definitionMessage(localType, globalNum, fields) {
  const w = new ByteWriter();
  w.pushUint8(0x40 | localType);
  w.pushUint8(0);
  w.pushUint8(0);
  w.pushUint16(globalNum);
  w.pushUint8(fields.length);
  fields.forEach(f => { w.pushUint8(f.num); w.pushUint8(f.size); w.pushUint8(f.type); });
  return w.toUint8Array();
}
const dataMessageHeader = (localType) => Uint8Array.from([localType & 0x0F]);

const IntensityCode = { active: 0, rest: 1, warmup: 2, cooldown: 3, recovery: 4, interval: 5 };
const DurationType = { time: 0, distance: 1, open: 5 };
const TargetType = { pace: 0, hr: 1, open: 2 };

function buildFileId(w, timeCreatedUnixSeconds) {
  w.pushBytes(definitionMessage(0, 0, [
    { num: 0, size: 1, type: T_ENUM }, { num: 1, size: 2, type: T_UINT16 },
    { num: 2, size: 2, type: T_UINT16 }, { num: 3, size: 4, type: T_UINT32Z },
    { num: 4, size: 4, type: T_UINT32 },
  ]));
  w.pushBytes(dataMessageHeader(0));
  w.pushUint8(5); // file type = workout
  w.pushUint16(255); // manufacturer = development
  w.pushUint16(0);
  w.pushUint32(0x1F2E3D4C);
  w.pushUint32(timeCreatedUnixSeconds - FIT_EPOCH_OFFSET);
}
function buildWorkout(w, name, numSteps) {
  const nameSize = Math.min(name.length + 1, 64);
  w.pushBytes(definitionMessage(1, 26, [
    { num: 8, size: nameSize, type: T_STRING }, { num: 4, size: 1, type: T_ENUM }, { num: 6, size: 2, type: T_UINT16 },
  ]));
  w.pushBytes(dataMessageHeader(1));
  w.pushString(name, nameSize);
  w.pushUint8(1); // sport = running
  w.pushUint16(numSteps);
}
function buildWorkoutStep(w, step) {
  const nameSize = Math.min((step.name || '').length + 1, 64);
  w.pushBytes(definitionMessage(2, 27, [
    { num: 0, size: nameSize, type: T_STRING }, { num: 1, size: 1, type: T_ENUM }, { num: 2, size: 4, type: T_UINT32 },
    { num: 3, size: 1, type: T_ENUM }, { num: 4, size: 4, type: T_UINT32 }, { num: 5, size: 4, type: T_UINT32 },
    { num: 6, size: 4, type: T_UINT32 }, { num: 7, size: 1, type: T_ENUM },
  ]));
  w.pushBytes(dataMessageHeader(2));
  w.pushString(step.name || '', nameSize);
  w.pushUint8(step.durationType);
  w.pushUint32(step.durationValue >>> 0);
  w.pushUint8(step.targetType);
  w.pushUint32((step.targetValue || 0) >>> 0);
  w.pushUint32((step.customLow || 0) >>> 0);
  w.pushUint32((step.customHigh || 0) >>> 0);
  w.pushUint8(step.intensity);
}

// steps: [{name, intensity:'active'|'warmup'|'cooldown'|'recovery'|'rest', duration:{type:'time',seconds}|{type:'distance',meters}|{type:'open'}, target:{type:'open'}|{type:'hr',lowBpm,highBpm}|{type:'pace',lowKmh,highKmh}}]
function buildWorkoutFit(workoutName, steps) {
  const body = new ByteWriter();
  buildFileId(body, Math.floor(Date.now() / 1000));
  buildWorkout(body, workoutName, steps.length);
  steps.forEach(s => {
    let durationType, durationValue = 0;
    if (s.duration.type === 'time') { durationType = DurationType.time; durationValue = Math.round(s.duration.seconds * 1000); }
    else if (s.duration.type === 'distance') { durationType = DurationType.distance; durationValue = Math.round(s.duration.meters * 100); }
    else { durationType = DurationType.open; durationValue = 0; }
    let targetType = TargetType.open, customLow = 0, customHigh = 0;
    if (s.target.type === 'hr') { targetType = TargetType.hr; customLow = Math.round(s.target.lowBpm); customHigh = Math.round(s.target.highBpm); }
    else if (s.target.type === 'pace') {
      targetType = TargetType.pace;
      const a = Math.round((s.target.lowKmh / 3.6) * 1000), b = Math.round((s.target.highKmh / 3.6) * 1000);
      customLow = Math.min(a, b); customHigh = Math.max(a, b);
    }
    buildWorkoutStep(body, {
      name: s.name, intensity: IntensityCode[s.intensity] ?? IntensityCode.active,
      durationType, durationValue, targetType, targetValue: 0, customLow, customHigh,
    });
  });
  const bodyBytes = body.toUint8Array();
  const header = new ByteWriter();
  header.pushUint8(12); header.pushUint8(0x10); header.pushUint16(2132);
  header.pushUint32(bodyBytes.length);
  header.pushBytes([0x2E, 0x46, 0x49, 0x54]);
  const headerBytes = header.toUint8Array();
  const fileNoCrc = new Uint8Array(headerBytes.length + bodyBytes.length);
  fileNoCrc.set(headerBytes, 0); fileNoCrc.set(bodyBytes, headerBytes.length);
  const crc = crc16(fileNoCrc);
  const out = new Uint8Array(fileNoCrc.length + 2);
  out.set(fileNoCrc, 0); out[fileNoCrc.length] = crc & 0xFF; out[fileNoCrc.length + 1] = (crc >> 8) & 0xFF;
  return out;
}

function downloadFit(name, bytes) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'seance'}.fit`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================================
// Domain helpers
// ============================================================================

const uid = () => Math.random().toString(36).slice(2, 9);

const SEANCE_TYPES = ['EF', 'Sortie longue', 'Sortie longue spécifique', 'Récupération', 'Fractionné court', 'Fractionné long', 'Côtes', 'Montée / concentrique', 'Descente / excentrique', 'Rando-course', 'Seuil', 'Autre'];
const CATEGORY_OF_TYPE = {
  'EF': 'easy', 'Sortie longue': 'easy', 'Récupération': 'easy',
  'Fractionné court': 'intense', 'Fractionné long': 'intense', 'Côtes': 'intense', 'Seuil': 'intense', 'Autre': 'easy',
};

function paceToKmh(str) {
  const m = /^(\d+):([0-5]?\d)$/.exec((str || '').trim());
  if (!m) return 0;
  const totalMin = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
  return totalMin > 0 ? 60 / totalMin : 0;
}

function kmhToPace(kmh) {
  if (!kmh || kmh <= 0) return '0:00';
  const totalMin = 60 / kmh;
  const mm = Math.floor(totalMin);
  const ss = Math.round((totalMin - mm) * 60);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}
function parseTimeToSeconds(str) {
  const parts = (str || '').split(':').map(p => parseInt(p, 10));
  if (parts.some(p => isNaN(p))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}
// Riegel race-time prediction: T2 = T1 * (D2/D1)^1.06, inverted to get the
// distance coverable in targetSec, hence the pace sustainable for that duration.
function paceKmhForDuration(refKm, refSec, targetSec) {
  if (!refKm || !refSec) return 0;
  const targetKm = refKm * Math.pow(targetSec / refSec, 1 / 1.06);
  return 3600 / (targetSec / targetKm);
}
function band(centerKmh) { return centerKmh ? [+(centerKmh * 0.96).toFixed(2), +(centerKmh * 1.04).toFixed(2)] : null; }
function karvonen(pct, fcMax, fcRepos) {
  if (!fcMax) return null;
  return Math.round(fcRepos ? fcRepos + pct * (fcMax - fcRepos) : pct * fcMax);
}
function computeZones({ refKm, refSec, fcMax, fcRepos }) {
  const thr = paceKmhForDuration(refKm, refSec, 3600);
  const fracLong = paceKmhForDuration(refKm, refSec, 1800);
  const fracCourt = paceKmhForDuration(refKm, refSec, 720);
  const ef = thr ? thr / 1.22 : 0;
  const sortieLongue = thr ? thr / 1.15 : 0;
  const recup = thr ? thr / 1.40 : 0;
  const hr = (lo, hi) => (fcMax ? [karvonen(lo, fcMax, fcRepos), karvonen(hi, fcMax, fcRepos)] : null);
  return {
    recup: { hr: hr(0.60, 0.70), paceKmh: band(recup) },
    ef: { hr: hr(0.70, 0.80), paceKmh: band(ef) },
    sortieLongue: { hr: hr(0.72, 0.82), paceKmh: band(sortieLongue) },
    seuil: { hr: hr(0.85, 0.90), paceKmh: band(thr) },
    fracLong: { hr: hr(0.88, 0.93), paceKmh: band(fracLong) },
    fracCourt: { hr: hr(0.92, 0.98), paceKmh: band(fracCourt) },
    cotes: { hr: hr(0.88, 0.97), paceKmh: null },
  };
}
const ZONE_KEY_OF_TYPE = {
  'EF': 'ef', 'Sortie longue': 'sortieLongue', 'Récupération': 'recup',
  'Fractionné court': 'fracCourt', 'Fractionné long': 'fracLong', 'Côtes': 'cotes', 'Seuil': 'seuil', 'Autre': 'ef',
};
function applyZoneToSimple(b, z) {
  if (!z) return b;
  const nb = { ...b };
  if (b.targetType === 'hr' && z.hr) { nb.hrLow = z.hr[0]; nb.hrHigh = z.hr[1]; }
  if (b.targetType === 'pace' && z.paceKmh) { nb.paceFast = kmhToPace(z.paceKmh[1]); nb.paceSlow = kmhToPace(z.paceKmh[0]); }
  return nb;
}
function applyZonesToLibrary(library, zones) {
  return library.map(t => {
    const mainZone = zones[ZONE_KEY_OF_TYPE[t.type]] || zones.ef;
    return {
      ...t, blocks: t.blocks.map(b => {
        if (b.kind === 'simple') {
          const z = b.intensity === 'warmup' || b.intensity === 'cooldown' ? zones.ef : b.intensity === 'recovery' ? zones.recup : mainZone;
          return applyZoneToSimple(b, z);
        } else if (b.kind === 'interval') {
          return { ...b, work: applyZoneToSimple(b.work, mainZone), rest: applyZoneToSimple(b.rest, zones.recup) };
        }
        return b;
      })
    };
  });
}

function simpleFieldsToStepInput(f) {
  const duration = f.durationType === 'time' ? { type: 'time', seconds: (f.durationValue || 0) * 60 }
    : f.durationType === 'distance' ? { type: 'distance', meters: (f.durationValue || 0) * 1000 }
    : { type: 'open' };
  let target = { type: 'open' };
  if (f.targetType === 'hr') target = { type: 'hr', lowBpm: f.hrLow || 0, highBpm: f.hrHigh || 0 };
  else if (f.targetType === 'pace') {
    // Two shapes exist: library templates store paces as text ("4:30"), while
    // generated road sessions store seconds-per-km numerically. Both must reach
    // the .fit file, or the watch gets a workout with no target at all.
    if (f.paceLow || f.paceHigh) {
      const slowSec = Math.max(f.paceLow || 0, f.paceHigh || 0);
      const fastSec = Math.min(f.paceLow || Infinity, f.paceHigh || Infinity);
      target = { type: 'pace', lowKmh: slowSec ? 3600 / slowSec : 0, highKmh: isFinite(fastSec) && fastSec ? 3600 / fastSec : 0 };
    } else {
      target = { type: 'pace', lowKmh: paceToKmh(f.paceSlow), highKmh: paceToKmh(f.paceFast) };
    }
  }
  return { name: f.label, duration, target };
}

function flattenBlocks(blocks) {
  const steps = [];
  (blocks || []).forEach(b => {
    if (b.kind === 'simple') {
      steps.push({ ...simpleFieldsToStepInput(b), intensity: b.intensity || 'active' });
    } else if (b.kind === 'interval') {
      const n = Math.max(1, b.repeat || 1);
      for (let i = 0; i < n; i++) {
        steps.push({ ...simpleFieldsToStepInput(b.work), intensity: 'active' });
        if (b.rest && (b.rest.durationType !== 'time' || (b.rest.durationValue || 0) > 0 || b.rest.durationType === 'open')) {
          steps.push({ ...simpleFieldsToStepInput(b.rest), intensity: 'recovery' });
        }
      }
    }
  });
  return steps;
}

function emptySimple(label = '', intensity = 'active') {
  return { kind: 'simple', id: uid(), label, durationType: 'time', durationValue: 20, targetType: 'open', hrLow: 120, hrHigh: 150, paceFast: '4:30', paceSlow: '5:00', intensity };
}
function emptyInterval() {
  return {
    kind: 'interval', id: uid(), repeat: 6,
    work: { label: 'Effort', durationType: 'time', durationValue: 3, targetType: 'pace', hrLow: 150, hrHigh: 170, paceFast: '4:00', paceSlow: '4:15' },
    rest: { label: 'Récupération', durationType: 'time', durationValue: 2, targetType: 'open', hrLow: 110, hrHigh: 130, paceFast: '6:00', paceSlow: '7:00' },
  };
}

// Ultra-specific sessions. The originals were road-flavoured (10x400m,
// 2x15min); these are built around what actually matters in trail: sustained
// climbs (concentric), controlled descents (eccentric — the main source of
// muscle damage on race day), technical footing and time on feet.
const ULTRA_LIBRARY = [
  { id: uid(), nom: 'Montées longues 4x12min', type: 'Montée / concentrique', discipline: 'trail', tags: ['Trail'], phase: 'specifique', distanceKm: 13, dureeMin: 75, deniveleM: 700, terrain: 'montee', specificite: 'concentrique', blocks: [
    { ...emptySimple('Échauffement roulant', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 4,
      work: { label: 'Montée soutenue', durationType: 'time', durationValue: 12, targetType: 'hr', hrLow: 155, hrHigh: 170 },
      rest: { label: 'Descente souple', durationType: 'time', durationValue: 6, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Descentes techniques 6x4min', type: 'Descente / excentrique', discipline: 'trail', tags: ['Trail'], phase: 'specifique', distanceKm: 12, dureeMin: 70, deniveleM: 600, terrain: 'descente', specificite: 'excentrique', blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 6,
      work: { label: 'Descente technique contrôlée', durationType: 'time', durationValue: 4, targetType: 'open' },
      rest: { label: 'Remontée en marche', durationType: 'time', durationValue: 6, targetType: 'hr', hrLow: 120, hrHigh: 145 } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Sortie longue vallonnée', type: 'Sortie longue', discipline: 'trail', tags: ['Trail'], phase: 'developpement', distanceKm: 25, dureeMin: 180, deniveleM: 1200, terrain: 'vallonne', specificite: 'mixte', blocks: [
    { ...emptySimple('Sortie longue en terrain vallonné', 'active'), durationType: 'time', durationValue: 180, targetType: 'hr', hrLow: 125, hrHigh: 150 },
  ]},
  { id: uid(), nom: 'Sortie longue montagne', type: 'Sortie longue spécifique', discipline: 'trail', tags: ['Trail'], phase: 'specifique', distanceKm: 30, dureeMin: 300, deniveleM: 2200, terrain: 'montagne', specificite: 'mixte', blocks: [
    { ...emptySimple('Temps sur les pieds en montagne', 'active'), durationType: 'time', durationValue: 300, targetType: 'hr', hrLow: 120, hrHigh: 148 },
  ]},
  { id: uid(), nom: 'Seuil en côte 3x10min', type: 'Seuil', discipline: 'trail', tags: ['Trail'], phase: 'specifique', distanceKm: 14, dureeMin: 70, deniveleM: 450, terrain: 'montee', specificite: 'concentrique', blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 3,
      work: { label: 'Bloc seuil montant', durationType: 'time', durationValue: 10, targetType: 'hr', hrLow: 158, hrHigh: 172 },
      rest: { label: 'Récupération descendante', durationType: 'time', durationValue: 5, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Rando-course dénivelé', type: 'Rando-course', discipline: 'trail', tags: ['Trail'], phase: 'specifique', distanceKm: 14, dureeMin: 150, deniveleM: 1400, terrain: 'montagne', specificite: 'concentrique', blocks: [
    { ...emptySimple('Marche rapide et course alternées en montée', 'active'), durationType: 'time', durationValue: 150, targetType: 'hr', hrLow: 125, hrHigh: 152 },
  ]},
  { id: uid(), nom: 'Sortie de nuit', type: 'EF', distanceKm: 12, dureeMin: 90, deniveleM: 500, terrain: 'technique', specificite: 'nuit', blocks: [
    { ...emptySimple('Course de nuit à la frontale', 'active'), durationType: 'time', durationValue: 90, targetType: 'hr', hrLow: 120, hrHigh: 145 },
  ]},
  { id: uid(), nom: 'Fractionné court en côte 10x1min', type: 'Fractionné court', discipline: 'trail', tags: ['Trail'], phase: 'developpement', distanceKm: 10, dureeMin: 55, deniveleM: 350, terrain: 'montee', specificite: 'concentrique', blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 10,
      work: { label: 'Montée vive', durationType: 'time', durationValue: 1, targetType: 'hr', hrLow: 165, hrHigh: 182 },
      rest: { label: 'Descente récup', durationType: 'time', durationValue: 2, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Fractionné long 5x6min vallonné', type: 'Fractionné long', distanceKm: 14, dureeMin: 70, deniveleM: 300, terrain: 'vallonne', specificite: 'mixte', blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 5,
      work: { label: 'Bloc allure course vallonné', durationType: 'time', durationValue: 6, targetType: 'hr', hrLow: 155, hrHigh: 170 },
      rest: { label: 'Récupération', durationType: 'time', durationValue: 3, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Footing de récupération', type: 'Récupération', distanceKm: 7, dureeMin: 40, deniveleM: 80, terrain: 'plat', specificite: 'aucune', blocks: [
    { ...emptySimple('Footing très facile, terrain roulant', 'active'), durationType: 'time', durationValue: 40, targetType: 'hr', hrLow: 100, hrHigh: 128 },
  ]},
  { id: uid(), nom: 'EF vallonnée', type: 'EF', distanceKm: 12, dureeMin: 75, deniveleM: 400, terrain: 'vallonne', specificite: 'mixte', blocks: [
    { ...emptySimple('Endurance fondamentale vallonnée', 'active'), durationType: 'time', durationValue: 75, targetType: 'hr', hrLow: 125, hrHigh: 148 },
  ]},
];

// Road session library. Mirrors the trail set so a road plan has real
// reference sessions to open, inspect and export — and so the discipline
// filter above actually has something to match.
const ROAD_LIBRARY = [
  { id: uid(), nom: 'Endurance fondamentale', type: 'EF', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 10, dureeMin: 55, deniveleM: 0, blocks: [
    { ...emptySimple('Footing en aisance respiratoire', 'active'), durationType: 'time', durationValue: 55, targetType: 'hr', hrLow: 125, hrHigh: 148 },
  ]},
  { id: uid(), nom: 'Footing de récupération', type: 'Récupération', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 6, dureeMin: 35, deniveleM: 0, blocks: [
    { ...emptySimple('Très facile, sans forcer', 'active'), durationType: 'time', durationValue: 35, targetType: 'hr', hrLow: 100, hrHigh: 128 },
  ]},
  { id: uid(), nom: 'Sortie longue', type: 'Sortie longue', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 24, dureeMin: 130, deniveleM: 0, blocks: [
    { ...emptySimple('Sortie longue à allure facile', 'active'), durationType: 'time', durationValue: 130, targetType: 'hr', hrLow: 125, hrHigh: 150 },
  ]},
  { id: uid(), nom: 'Sortie longue avec finish rapide', type: 'Sortie longue progressive', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 26, dureeMin: 140, deniveleM: 0, blocks: [
    { ...emptySimple('Partie facile', 'active'), durationType: 'time', durationValue: 100, targetType: 'hr', hrLow: 125, hrHigh: 148 },
    { ...emptySimple('Finish à allure marathon', 'active'), durationType: 'time', durationValue: 40, targetType: 'hr', hrLow: 150, hrHigh: 165 },
  ]},
  { id: uid(), nom: 'Allure marathon 2x5 km', type: 'Allure spécifique', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 18, dureeMin: 85, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 2,
      work: { label: '5 km @ allure marathon', durationType: 'distance', durationValue: 5, targetType: 'hr', hrLow: 150, hrHigh: 165 },
      rest: { label: 'Récupération trottinée', durationType: 'time', durationValue: 3, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Allure marathon 3x4 km', type: 'Allure spécifique', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 19, dureeMin: 90, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 3,
      work: { label: '4 km @ allure marathon', durationType: 'distance', durationValue: 4, targetType: 'hr', hrLow: 150, hrHigh: 165 },
      rest: { label: 'Récupération trottinée', durationType: 'time', durationValue: 3, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Seuil 20 min continu', type: 'Seuil', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 12, dureeMin: 55, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 20, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { ...emptySimple('20 min au seuil', 'active'), durationType: 'time', durationValue: 20, targetType: 'hr', hrLow: 158, hrHigh: 172 },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 15, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Seuil 2x15 min', type: 'Seuil', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 14, dureeMin: 70, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 2,
      work: { label: '15 min au seuil', durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 158, hrHigh: 172 },
      rest: { label: 'Récupération', durationType: 'time', durationValue: 3, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 12, targetType: 'open' },
  ]},
  { id: uid(), nom: 'VMA longue 6x1000m', type: 'Fractionné long', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 13, dureeMin: 60, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 6,
      work: { label: '1000 m', durationType: 'distance', durationValue: 1, targetType: 'hr', hrLow: 165, hrHigh: 180 },
      rest: { label: 'Récupération 2 min', durationType: 'time', durationValue: 2, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'VMA courte 10x400m', type: 'Fractionné court', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 10, dureeMin: 50, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 10,
      work: { label: '400 m', durationType: 'distance', durationValue: 0.4, targetType: 'hr', hrLow: 170, hrHigh: 185 },
      rest: { label: 'Récupération 1 min', durationType: 'time', durationValue: 1, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Fractionné du jeudi — 12x300m', type: 'Fractionné court', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 9, dureeMin: 45, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement collectif', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 12,
      work: { label: '300 m vite', durationType: 'distance', durationValue: 0.3, targetType: 'hr', hrLow: 172, hrHigh: 188 },
      rest: { label: 'Récupération 1 min', durationType: 'time', durationValue: 1, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 8, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Allure semi 3x3 km', type: 'Allure spécifique', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 16, dureeMin: 75, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 3,
      work: { label: '3 km @ allure semi', durationType: 'distance', durationValue: 3, targetType: 'hr', hrLow: 155, hrHigh: 170 },
      rest: { label: 'Récupération', durationType: 'time', durationValue: 3, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Allure 10 km — 6x1 km', type: 'Allure spécifique', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 13, dureeMin: 60, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 6,
      work: { label: '1 km @ allure 10 km', durationType: 'distance', durationValue: 1, targetType: 'hr', hrLow: 162, hrHigh: 178 },
      rest: { label: 'Récupération 90 s', durationType: 'time', durationValue: 1.5, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Seuil long 40 min', type: 'Seuil', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 16, dureeMin: 75, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 20, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { ...emptySimple('40 min au seuil', 'active'), durationType: 'time', durationValue: 40, targetType: 'hr', hrLow: 156, hrHigh: 170 },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 15, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Fartlek 10x(1 min vite / 1 min souple)', type: 'Fractionné court', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 11, dureeMin: 50, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 10,
      work: { label: '1 min vite', durationType: 'time', durationValue: 1, targetType: 'hr', hrLow: 168, hrHigh: 184 },
      rest: { label: '1 min souple', durationType: 'time', durationValue: 1, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 12, targetType: 'open' },
  ]},
  { id: uid(), nom: 'VMA 8x500m', type: 'Fractionné long', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 11, dureeMin: 52, deniveleM: 0, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 8,
      work: { label: '500 m', durationType: 'distance', durationValue: 0.5, targetType: 'hr', hrLow: 168, hrHigh: 184 },
      rest: { label: 'Récupération 90 s', durationType: 'time', durationValue: 1.5, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Sortie longue courte (semi/10 km)', type: 'Sortie longue', discipline: 'route', terrain: 'plat', specificite: 'aucune', distanceKm: 16, dureeMin: 90, deniveleM: 0, blocks: [
    { ...emptySimple('Sortie longue à allure facile', 'active'), durationType: 'time', durationValue: 90, targetType: 'hr', hrLow: 125, hrHigh: 150 },
  ]},
];

const DEFAULT_LIBRARY = [
  { id: uid(), nom: 'EF 1h', type: 'EF', distanceKm: 10, dureeMin: 60, deniveleM: 100, blocks: [
    { ...emptySimple('Endurance fondamentale', 'active'), durationType: 'time', durationValue: 60, targetType: 'hr', hrLow: 125, hrHigh: 148 },
  ]},
  { id: uid(), nom: 'Sortie longue 2h', type: 'Sortie longue', distanceKm: 20, dureeMin: 120, deniveleM: 400, blocks: [
    { ...emptySimple('Sortie longue', 'active'), durationType: 'time', durationValue: 120, targetType: 'hr', hrLow: 128, hrHigh: 150 },
  ]},
  { id: uid(), nom: 'Récupération 30min', type: 'Récupération', distanceKm: 5, dureeMin: 30, deniveleM: 20, blocks: [
    { ...emptySimple('Footing très facile', 'active'), durationType: 'time', durationValue: 30, targetType: 'hr', hrLow: 100, hrHigh: 125 },
  ]},
  { id: uid(), nom: 'Fractionné court 10x400m', type: 'Fractionné court', distanceKm: 9, dureeMin: 50, deniveleM: 20, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 10,
      work: { label: '400m rapide', durationType: 'distance', durationValue: 0.4, targetType: 'pace', paceFast: '3:45', paceSlow: '4:00' },
      rest: { label: '200m récup', durationType: 'distance', durationValue: 0.2, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Fractionné long 5x1000m', type: 'Fractionné long', distanceKm: 13, dureeMin: 65, deniveleM: 30, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 5,
      work: { label: '1000m seuil', durationType: 'distance', durationValue: 1, targetType: 'pace', paceFast: '4:05', paceSlow: '4:20' },
      rest: { label: '300m récup', durationType: 'distance', durationValue: 0.3, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Côtes 8x300m', type: 'Côtes', distanceKm: 10, dureeMin: 55, deniveleM: 250, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 8,
      work: { label: 'Côte 300m', durationType: 'distance', durationValue: 0.3, targetType: 'hr', hrLow: 160, hrHigh: 178 },
      rest: { label: 'Descente récup', durationType: 'time', durationValue: 1.5, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
  { id: uid(), nom: 'Seuil 2x15min', type: 'Seuil', distanceKm: 12, dureeMin: 55, deniveleM: 50, blocks: [
    { ...emptySimple('Échauffement', 'warmup'), durationType: 'time', durationValue: 15, targetType: 'hr', hrLow: 120, hrHigh: 140 },
    { kind: 'interval', id: uid(), repeat: 2,
      work: { label: 'Bloc seuil', durationType: 'time', durationValue: 15, targetType: 'pace', paceFast: '4:15', paceSlow: '4:25' },
      rest: { label: 'Récupération', durationType: 'time', durationValue: 3, targetType: 'open' } },
    { ...emptySimple('Retour au calme', 'cooldown'), durationType: 'time', durationValue: 10, targetType: 'open' },
  ]},
];

const DAYS = [
  { key: 'lun', label: 'Lundi' }, { key: 'mar', label: 'Mardi' }, { key: 'mer', label: 'Mercredi' },
  { key: 'jeu', label: 'Jeudi' }, { key: 'ven', label: 'Vendredi' }, { key: 'sam', label: 'Samedi' }, { key: 'dim', label: 'Dimanche' },
];

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function weekKey(monday) { return monday.toISOString().slice(0, 10); }
function fmtShort(d) { return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); }
function emptyWeekPlan() { const p = {}; DAYS.forEach(d => p[d.key] = []); return p; }

// ============================================================================
// Periodization engine.
//
// One driving variable: km-effort (km-éq = km + D+/100, the ITRA/FFA standard
// used across the French trail community). Everything else — km, D+, hours —
// is derived from it each week, so the three can never drift apart.
//
//   - D+ comes from a "specificity ratio" (m of D+ per km-éq) that converges
//     from the runner's current terrain toward the race's own ratio over the
//     build phase. That convergence IS the specificity work.
//   - Hours come from the runner's training pace in min/km-éq, derived from
//     their stated current weekly hours and volume.
//   - Choc weekends are reasoned in HOURS: the last one aims at the estimated
//     race duration, hard-capped by (days × max hours/day). For a 100K the cap
//     barely bites; for a 170K it bites hard — which is the honest answer:
//     beyond ~100K no weekend replicates the race.
//
// Known limits of km-effort (shown in the UI, not hidden): it underestimates
// effort beyond ~50K and on very technical ground, and some chrono-based
// analyses find 100m D+ closer to 0.6km flat than 1km.
// ============================================================================

// ---------------------------------------------------------------------------
// Discipline strategies.
//
// Road and trail are not the same sport from a planning standpoint: road has
// no D+ to converge toward, no choc weekends (you don't rehearse a marathon
// over two days), and pace work matters far more than time on feet. Rather
// than branching all over the engine later, each discipline declares what it
// wants here, and the engine reads these flags.
//
// Only 'trail' is fully wired today; 'route' is scaffolding so that adding it
// later is a matter of filling a strategy, not rewriting the periodization.
// ---------------------------------------------------------------------------
// --- V4 capacity constants -------------------------------------------------
// Centralised so the rules live in one place instead of scattered literals.
// These caps govern WEEKDAYS only: the weekend is where ultra volume actually
// happens (choc weekends run 8-10h/day), so applying a 4h daily ceiling there
// would make any ultra preparation impossible by construction.
const MAX_SESSION_HOURS = 2;      // weekday session ceiling
const MAX_SESSIONS_PER_DAY = 2;   // weekday, and only when genuinely required
const MAX_DAILY_HOURS = 4;        // weekday total
const WEEKEND_KEYS = ['sam', 'dim'];
// A "free" weekend day is not 24 usable hours. For capacity planning we treat
// it as a realistic ultra day; the choc-weekend logic keeps its own ceiling.
const WEEKEND_PLANNING_CAP_HOURS = 8;
const isWeekendDay = (k) => WEEKEND_KEYS.indexOf(k) >= 0;

// --- Macrocycles -----------------------------------------------------------
// A second, coarser layer above the weekly phases (reprise/charge/choc/...).
// The weekly phase says how hard THIS week is; the macrocycle says what the
// training is FOR at this point of the preparation.
const MACROCYCLES = {
  anticipation: { label: 'Mise en route', short: 'MISE EN ROUTE', color: '#8B7BD8' },
  developpement: { label: 'VMA & force', short: 'VMA & FORCE', color: '#5DCAA5' },
  specifique: { label: 'Seuil & allure course', short: 'SEUIL & ALLURE', color: '#EF9F27' },
  affutage: { label: 'Affûtage', short: 'AFFÛTAGE', color: '#85B7EB' },
};

// ---------------------------------------------------------------------------
// Road training paces.
//
// Derived from a reference performance (or the best history entry) via Riegel
// extrapolation, then expressed as the classic training zones. These are
// PROPOSED paces — the user can override the goal, but is warned when the goal
// is far from what the reference performance supports.
// ---------------------------------------------------------------------------
const PACE_ZONES = {
  easy:      { label: 'Endurance fondamentale', factor: 1.30 },
  marathon:  { label: 'Allure marathon',        factor: 1.06 },
  threshold: { label: 'Seuil',                  factor: 1.00 },
  interval:  { label: 'VMA / intervalles',      factor: 0.93 },
  repetition:{ label: 'Vitesse',                factor: 0.88 },
};

// Threshold pace ~= pace sustainable for about an hour, approximated from a
// reference race via Riegel (t2 = t1 * (d2/d1)^1.06).
function riegelSecondsFor(refKm, refSec, targetKm) {
  if (!refKm || !refSec || !targetKm) return 0;
  return refSec * Math.pow(targetKm / refKm, 1.06);
}
function computeRoadPaces(refKm, refSec) {
  if (!refKm || !refSec) return null;
  // Pace (s/km) at threshold: use the runner's ~1h race distance.
  const hourDistance = refKm * Math.pow(3600 / refSec, 1 / 1.06);
  const thresholdPace = hourDistance > 0 ? 3600 / hourDistance : refSec / refKm;
  const out = {};
  Object.keys(PACE_ZONES).forEach(k => {
    out[k] = { label: PACE_ZONES[k].label, secPerKm: Math.round(thresholdPace * PACE_ZONES[k].factor) };
  });
  return out;
}
function fmtPace(secPerKm) {
  if (!secPerKm || !isFinite(secPerKm)) return '—';
  const m = Math.floor(secPerKm / 60), s = Math.round(secPerKm % 60);
  return `${m}'${String(s).padStart(2, '0')}/km`;
}
// Is the user's stated goal realistic against their reference performance?
function assessGoal(refKm, refSec, targetKm, goalSec) {
  if (!refKm || !refSec || !targetKm || !goalSec) return null;
  const predicted = riegelSecondsFor(refKm, refSec, targetKm);
  const ratio = goalSec / predicted;
  if (ratio < 0.90) return { level: 'high', predicted, text: "Cet objectif est nettement plus rapide que ce que ta performance de référence laisse prévoir. Atteignable seulement avec une très grosse progression — le risque est de partir trop vite le jour J." };
  if (ratio < 0.97) return { level: 'stretch', predicted, text: 'Objectif ambitieux mais crédible avec une préparation bien menée.' };
  if (ratio > 1.12) return { level: 'conservative', predicted, text: 'Objectif prudent au regard de ta référence — tu as probablement de la marge.' };
  return { level: 'ok', predicted, text: 'Objectif cohérent avec ta performance de référence.' };
}

// ---------------------------------------------------------------------------
// Road volume model.
//
// Fundamentally different from ultra. In ultra the weekly peak sits BELOW the
// race distance (you don't rehearse 170 km). On the road it sits well ABOVE:
// a marathon is trained by accumulating 1.5-2x the race distance every week.
// Using the ultra formula produced a 41 km/week peak for a marathon, which is
// roughly half of what any serious plan prescribes.
//
// Reference points: intermediate marathon plans peak at 45-55 miles (72-88 km),
// beginners 30-40 miles (48-64 km), sub-3 plans 60-80 miles. A large study of
// Boston finishers associated 64-68 km/week with faster times.
// ---------------------------------------------------------------------------
// Each road distance has its own physiology, so each gets its own profile
// rather than a marathon plan scaled down. The 10K is trained around VO2max,
// the half around threshold, the marathon around race-pace endurance — the
// volumes follow from that, they don't drive it.
const ROAD_DISTANCE_PROFILES = {
  '10k':      { label: '10 km',    maxWeeks: 12, minWeeks: 8,  taperWeeks: 2,
                peak: { standard: 40, aguerri: 48, tres_experimente: 58 },
                longRunMax: 16, paceLabel: 'Allure 10 km', racePaceZone: 'threshold' },
  'semi':     { label: 'Semi',     maxWeeks: 16, minWeeks: 10, taperWeeks: 2,
                peak: { standard: 45, aguerri: 58, tres_experimente: 70 },
                longRunMax: 21, paceLabel: 'Allure semi',  racePaceZone: 'threshold' },
  'marathon': { label: 'Marathon', maxWeeks: 20, minWeeks: 12, taperWeeks: 3,
                peak: { standard: 50, aguerri: 65, tres_experimente: 85 },
                longRunMax: 34, paceLabel: 'Allure marathon', racePaceZone: 'marathon' },
};
function roadDistanceKey(raceKm) {
  if (!raceKm || raceKm <= 0) return 'marathon';
  if (raceKm <= 15) return '10k';
  if (raceKm <= 30) return 'semi';
  return 'marathon';
}
function roadProfile(raceKm) { return ROAD_DISTANCE_PROFILES[roadDistanceKey(raceKm)]; }

// Recommended weekly peak, from the distance profile and the athlete's tier,
// nudged by how far the race is from the canonical distance.
function roadRecommendedPeak(raceKm, tier) {
  const p = roadProfile(raceKm);
  const base = p.peak[tier] || p.peak.standard;
  const canonical = roadDistanceKey(raceKm) === '10k' ? 10 : roadDistanceKey(raceKm) === 'semi' ? 21.1 : 42.2;
  const adj = raceKm > 0 ? Math.min(1.25, Math.max(0.8, raceKm / canonical)) : 1;
  return Math.round(base * (0.75 + 0.25 * adj));
}

// ---------------------------------------------------------------------------
// Road key sessions.
//
// The golden rule every source agrees on: the key sessions are non-negotiable.
// If something has to give, it's easy volume — never the quality work. That's
// the exact opposite of what the ultra engine did, where the weekend long run
// absorbed everything and the midweek was filler.
//
// Four pillars: long run, marathon-pace work, threshold, and VO2/intervals,
// plus a fast-finish long run that teaches running hard on tired legs.
// ---------------------------------------------------------------------------
const ROAD_KEY_TYPES = ['Sortie longue', 'Allure spécifique', 'Seuil', 'Fractionné long', 'Fractionné court', 'Sortie longue progressive'];

// Marathon-pace work progresses across the build — "manageable" to "predictive".
const MP_PROGRESSION_BY_DISTANCE = {
  '10k':      [{ reps: 4, km: 1 }, { reps: 5, km: 1 }, { reps: 6, km: 1 }, { reps: 3, km: 2 }, { reps: 4, km: 2 }],
  'semi':     [{ reps: 3, km: 2 }, { reps: 3, km: 3 }, { reps: 4, km: 3 }, { reps: 2, km: 5 }, { reps: 2, km: 6 }],
  'marathon': [{ reps: 2, km: 3 }, { reps: 2, km: 4 }, { reps: 2, km: 5 }, { reps: 3, km: 4 }, { reps: 3, km: 5 }, { reps: 1, km: 15 }],
};
// Threshold work: 20 min continuous up to 2x5 km.
const THRESHOLD_PROGRESSION_BY_DISTANCE = {
  '10k':      [{ reps: 1, minutes: 15 }, { reps: 2, minutes: 10 }, { reps: 3, minutes: 8 }, { reps: 2, minutes: 12 }],
  'semi':     [{ reps: 1, minutes: 20 }, { reps: 2, minutes: 15 }, { reps: 2, minutes: 20 }, { reps: 3, minutes: 15 }, { reps: 1, minutes: 40 }],
  'marathon': [{ reps: 1, minutes: 20 }, { reps: 2, minutes: 12 }, { reps: 2, minutes: 15 }, { reps: 3, minutes: 12 }, { reps: 2, minutes: 20 }],
};

// Which key session leads the week, by macrocycle. Base builds the engine;
// the specific block is where marathon pace becomes the centre of gravity.
// The centre of gravity moves with the distance: VO2max on the 10K, threshold
// on the half, race-pace endurance on the marathon. Scaling one marathon
// rotation down would train the wrong quality for the shorter races.
function roadWeeklyKeys(macro, rotIdx, raceKm) {
  const dist = roadDistanceKey(raceKm);

  if (dist === '10k') {
    if (macro === 'anticipation' || macro === 'developpement') {
      return rotIdx % 2 === 0 ? ['Fractionné court', 'Sortie longue'] : ['Seuil', 'Sortie longue'];
    }
    if (macro === 'specifique') {
      const k = rotIdx % 3;
      if (k === 0) return ['Fractionné long', 'Sortie longue'];        // VO2max is the priority
      if (k === 1) return ['Allure spécifique', 'Sortie longue'];       // race-pace reps
      return ['Fractionné court', 'Sortie longue progressive'];
    }
    return ['Fractionné court', 'Sortie longue'];
  }

  if (dist === 'semi') {
    if (macro === 'anticipation' || macro === 'developpement') {
      return rotIdx % 2 === 0 ? ['Seuil', 'Sortie longue'] : ['Fractionné long', 'Sortie longue'];
    }
    if (macro === 'specifique') {
      const k = rotIdx % 3;
      if (k === 0) return ['Seuil', 'Sortie longue'];                   // threshold IS half pace
      if (k === 1) return ['Allure spécifique', 'Sortie longue progressive'];
      return ['Fractionné long', 'Sortie longue'];
    }
    return ['Seuil', 'Sortie longue'];
  }

  // Marathon
  if (macro === 'anticipation' || macro === 'developpement') {
    return rotIdx % 2 === 0 ? ['Fractionné court', 'Sortie longue'] : ['Seuil', 'Sortie longue'];
  }
  if (macro === 'specifique') {
    const k = rotIdx % 3;
    if (k === 0) return ['Allure spécifique', 'Sortie longue'];
    if (k === 1) return ['Seuil', 'Sortie longue progressive'];
    return ['Fractionné long', 'Sortie longue'];
  }
  return ['Fractionné court', 'Sortie longue'];
}

// ---------------------------------------------------------------------------
// R7 — Benchmark sessions ("séances test").
//
// Dated checkpoints where the plan states what you should be able to do today.
// The user reports pass / partial / fail and the plan reacts — but never
// silently: research is explicit that a single session cannot prove marathon
// readiness (endurance, fuelling and pacing all sit outside it), so the app
// proposes and explains rather than deciding. Riegel extrapolation from a real
// race is a better predictor than any workout; the tests are a clue, not a
// verdict. A test REPLACES that week's key session — it is itself hard work.
// ---------------------------------------------------------------------------
const BENCHMARK_DEFS = {
  // Keyed by race distance bucket.
  short:    [{ reps: 6, km: 1, label: '6 × 1 km @ allure course' }],
  half:     [{ reps: 3, km: 3, label: '3 × 3 km @ allure course' }],
  marathon: [{ reps: 2, km: 5, label: '2 × 5 km @ allure marathon' }],
};
function benchmarkBucket(raceKm) {
  if (raceKm <= 15) return 'short';
  if (raceKm <= 30) return 'half';
  return 'marathon';
}
// Three checkpoints: mid-build, the predictive one, and a light confirmation.
// The predictive test sits 4-5 weeks out — the window coaches use to settle the
// final goal pace once the bulk of the work is done.
const BENCHMARK_SCHEDULE_BY_DISTANCE = {
  '10k': [
    { weeksBefore: 4, kind: 'intermediaire', scale: 0.7, label: 'Test intermédiaire' },
    { weeksBefore: 2, kind: 'predictif',     scale: 1.0, label: 'Test prédictif' },
    { weeksBefore: 1, kind: 'confirmation',  scale: 0.5, label: 'Test de confirmation' },
  ],
  'semi': [
    { weeksBefore: 6, kind: 'intermediaire', scale: 0.6, label: 'Test intermédiaire' },
    { weeksBefore: 3, kind: 'predictif',     scale: 1.0, label: 'Test prédictif' },
    { weeksBefore: 1, kind: 'confirmation',  scale: 0.5, label: 'Test de confirmation' },
  ],
  'marathon': [
    { weeksBefore: 8, kind: 'intermediaire', scale: 0.6, label: 'Test intermédiaire' },
    { weeksBefore: 4, kind: 'predictif',     scale: 1.0, label: 'Test prédictif' },
    { weeksBefore: 2, kind: 'confirmation',  scale: 0.5, label: 'Test de confirmation' },
  ],
};
function benchmarkFor(weeksBeforeRace, raceKm, paces) {
  const schedule = BENCHMARK_SCHEDULE_BY_DISTANCE[roadDistanceKey(raceKm)];
  const slot = schedule.find(s => s.weeksBefore === weeksBeforeRace);
  if (!slot) return null;
  const base = BENCHMARK_DEFS[benchmarkBucket(raceKm)][0];
  const reps = Math.max(2, Math.round(base.reps * slot.scale));
  const targetZone = ROAD_DISTANCE_PROFILES[roadDistanceKey(raceKm)].racePaceZone;
  return {
    kind: slot.kind, weeksBefore: slot.weeksBefore, label: slot.label,
    description: `${reps} × ${base.km} km @ allure course`,
    reps, km: base.km, zone: targetZone,
    targetPace: paces && paces[targetZone] ? paces[targetZone].secPerKm : 0,
  };
}
// How the plan reacts to a reported result. Deliberately conservative: one bad
// session changes nothing, two in a row is a real signal.
function benchmarkAdvice(result, consecutiveFails) {
  if (result === 'reussi') return { tone: 'ok', text: "Objectif confirmé sur ce test. Rien ne change dans le plan." };
  if (result === 'partiel') return { tone: 'ok', text: "Réussi difficilement — c'est normal, ces séances doivent être dures. Le plan continue tel quel." };
  if (consecutiveFails >= 2) return {
    tone: 'alert',
    text: "Deux tests manqués d'affilée : ce n'est plus un hasard. Réajuster l'objectif est la décision la plus sûre — sinon le risque est de partir trop vite le jour J et de payer très cher après 30 km.",
    options: ['Réajuster l\'objectif', 'Allonger la prépa si possible', 'Maintenir en connaissance de cause'],
  };
  return {
    tone: 'warn',
    text: "Test manqué. Une mauvaise nuit, la chaleur ou une semaine chargée suffisent à rater une séance — le plan ne change rien pour l'instant. Si le prochain test passe mal aussi, il faudra reparler de l'objectif.",
    options: ['Continuer sans changement', 'Réajuster l\'objectif maintenant'],
  };
}

const DISCIPLINE_STRATEGIES = {
  trail: {
    label: 'Trail / Ultra',
    usesChocWeekends: true,
    usesPicChoc: true,
    convergeDPlusRatio: true,
    // Time on feet is the currency.
    primaryMetric: 'kmEq',
    longRunDay: 'dim',
    qualityTypes: ['Seuil', 'Descente / excentrique', 'Montée / concentrique', 'Côtes', 'Rando-course', 'Sortie longue spécifique'],
    // Which session types each macrocycle favours when selecting from the library.
    phaseTypes: {
      anticipation: ['Descente / excentrique', 'Côtes', 'EF', 'Récupération'],
      developpement: ['EF', 'Fractionné court', 'Côtes', 'Sortie longue', 'Récupération'],
      specifique: ['Sortie longue spécifique', 'Côtes', 'Rando-course', 'Seuil', 'Descente / excentrique', 'Fractionné long', 'Sortie longue'],
      affutage: ['Fractionné court', 'EF', 'Récupération', 'Seuil'],
    },
  },
  route: {
    label: 'Route',
    usesChocWeekends: false,
    usesPicChoc: false,
    convergeDPlusRatio: false,
    // Pace-specific work is the currency; volume is plain km.
    primaryMetric: 'km',
    longRunDay: 'dim',
    qualityTypes: ['Allure spécifique', 'Seuil', 'Fractionné long', 'Fractionné court'],
    phaseTypes: {
      anticipation: ['EF', 'Fractionné court', 'Récupération'],
      developpement: ['EF', 'Fractionné court', 'Seuil', 'Sortie longue', 'Récupération'],
      specifique: ['Allure spécifique', 'Seuil', 'Fractionné long', 'Sortie longue progressive', 'Sortie longue', 'EF'],
      affutage: ['Fractionné court', 'EF', 'Récupération'],
    },
  },
};
function disciplineStrategy(key) { return DISCIPLINE_STRATEGIES[key] || DISCIPLINE_STRATEGIES.trail; }

function parseISODate(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

const KMEQ_PER_100M = 1; // 100 m D+ = 1 km-éq (ITRA/FFA simple formula)
const DEFAULT_PACE_MIN_PER_KMEQ = 7.5; // easy trail pace fallback

function toKmEq(km, dplus) { return (km || 0) + (dplus || 0) / 100 * KMEQ_PER_100M; }
function splitKmEq(kmEq, ratio) {
  // ratio: metres of D+ per km-éq. D+ = kmEq*ratio ; km = kmEq - D+/100.
  const dplus = kmEq * ratio;
  const km = Math.max(0, kmEq - dplus / 100);
  return { km, dplus };
}

// Beyond marathon-equivalent distance, fatigue slows pace beyond what pure
// Riegel extrapolation predicts — documented as 15-35% in ultras, even among
// elites. Scales in smoothly past 42 km-éq, capped at +35%.
function ultraFatigueFactor(kmEq) {
  if (kmEq <= 42) return 1;
  return 1 + Math.min(0.35, (kmEq - 42) * 0.004);
}
// Predicts a race duration from a real reference performance (any distance),
// via Riegel (T2 = T1·(D2/D1)^1.06) then the ultra fatigue correction. Returns
// [low, high] hours — no single-number promise, matching how every serious
// trail time predictor presents this (TrailMath, TrailRunTemple, etc).
function riegelRaceHoursRange(refKm, refSec, targetKmEq) {
  if (!refKm || !refSec || !targetKmEq) return null;
  const base = (refSec * Math.pow(targetKmEq / refKm, 1.06) / 3600) * ultraFatigueFactor(targetKmEq);
  return [base * 0.90, base * 1.25]; // races run long far more often than short
}
// Fallback when no reference performance is on file: broad pace-per-km-éq
// bands, keyed by the SAME tier used for ramp speed — no separate "niveau
// déclaré" concept, one experience signal drives both.
const EXPERIENCE_BANDS = {
  standard: [8, 11], aguerri: [6.5, 8.5], tres_experimente: [5, 6.5],
};
function experienceRaceHoursRange(tier, targetKmEq) {
  const band = EXPERIENCE_BANDS[tier] || EXPERIENCE_BANDS.standard;
  return [(targetKmEq * band[0]) / 60, (targetKmEq * band[1]) / 60];
}

// ---------------------------------------------------------------------------
// History (Profil tab) — endurance background used to predict race time and
// pick a training-tier, instead of a single "aggressive" checkbox.
// ---------------------------------------------------------------------------
const DISCIPLINES = [
  { key: 'course_a_pied', label: 'Course à pied', distance: 'required', dplus: 'optional', terrain: 'optional', runLike: true },
  { key: 'trail', label: 'Trail', distance: 'required', dplus: 'required', terrain: 'optional', runLike: true },
  { key: 'triathlon', label: 'Triathlon / ultra-triathlon', distance: 'optional', dplus: 'hidden', terrain: 'hidden', runLike: false },
  { key: 'velo', label: 'Vélo longue distance', distance: 'required', dplus: 'required', terrain: 'hidden', runLike: false },
  { key: 'ski_rando', label: 'Ski de randonnée', distance: 'required', dplus: 'required', terrain: 'hidden', runLike: false },
  { key: 'natation', label: 'Natation longue distance', distance: 'required', dplus: 'hidden', terrain: 'hidden', runLike: false },
  { key: 'autre', label: 'Autre endurance', distance: 'optional', dplus: 'optional', terrain: 'optional', runLike: false },
];
function disciplineConfig(key) { return DISCIPLINES.find(d => d.key === key) || DISCIPLINES[DISCIPLINES.length - 1]; }
const EFFORT_OPTIONS = {
  course: [{ v: 'maximal', l: 'Maximal' }, { v: 'controle', l: 'Contrôlé' }, { v: 'reco', l: 'Promenade / reco' }],
  entrainement: [{ v: 'facile', l: 'Facile' }, { v: 'modere', l: 'Modéré' }, { v: 'difficile', l: 'Difficile' }],
};
const TERRAIN_OPTIONS = ['Roulant', 'Chemin roulant', 'Sentier technique', 'Haute montagne'];

function historyEntryKmEq(e) { return toKmEq(e.distanceKm || 0, e.deniveleM || 0); }

// Training-run entries predict from the pace actually held, not from a
// maximal-effort extrapolation; race entries go through Riegel. Both get the
// same ultra-fatigue correction, normalized against the fatigue already
// "baked into" the reference effort itself.
function predictFromHistoryEntry(entry, targetKmEq) {
  const entryKmEq = historyEntryKmEq(entry);
  if (!entryKmEq || !entry.tempsSec || !targetKmEq) return null;
  if (entry.contexte === 'entrainement') {
    const paceSecPerKmEq = entry.tempsSec / entryKmEq;
    const base = (paceSecPerKmEq * targetKmEq / 3600) * (ultraFatigueFactor(targetKmEq) / ultraFatigueFactor(entryKmEq));
    return [base * 0.90, base * 1.20];
  }
  return riegelRaceHoursRange(entryKmEq, entry.tempsSec, targetKmEq);
}

// Picks the running/trail entry whose km-éq is closest to the target race,
// penalizing age — always explainable (return the entry itself, not just a
// number) so the UI can show "based on: <name>, <date>".
function pickBestHistoryMatch(history, targetKmEq) {
  const candidates = (history || []).filter(e => disciplineConfig(e.discipline).runLike && e.distanceKm && e.tempsSec);
  if (!candidates.length || !targetKmEq) return null;
  const now = Date.now();
  let best = null, bestScore = Infinity;
  candidates.forEach(e => {
    const eKmEq = historyEntryKmEq(e);
    if (!eKmEq) return;
    const ratio = Math.max(eKmEq / targetKmEq, targetKmEq / eKmEq);
    const ageDays = e.date ? (now - new Date(e.date).getTime()) / 86400000 : 3650;
    const score = Math.log(ratio) + Math.min(1, ageDays / 730) * 0.3;
    if (score < bestScore) { bestScore = score; best = e; }
  });
  return best;
}

// Endurance background feeds the RAMP-SPEED tier (how fast volume can climb
// safely), never the choc-weekend specificity — those are separate axes.
// Thresholds are a starting judgment call, not a validated formula.
// Ramp-speed tier: how fast this athlete can absorb load. This is a property
// of the ATHLETE, not of the goal — deliberately computed from absolute
// history values, never relative to the race being planned. (An earlier
// version divided by race size, so picking a bigger race silently downgraded
// your tier, which is backwards: your body doesn't absorb load worse because
// you signed up for a longer event.)
// Thresholds are a starting judgment call, not a validated formula.
function suggestTierFromHistory(history) {
  if (!history || !history.length) return null;
  const longestRunKmEq = Math.max(0, ...history.filter(e => disciplineConfig(e.discipline).runLike && e.distanceKm).map(historyEntryKmEq));
  const longestEffortH = Math.max(0, ...history.filter(e => e.tempsSec).map(e => e.tempsSec / 3600));
  const nLongEfforts = history.filter(e => e.tempsSec && e.tempsSec / 3600 >= 4).length;
  if (longestRunKmEq >= 90 || longestEffortH >= 10 || nLongEfforts >= 4) return 'tres_experimente';
  if (longestRunKmEq >= 45 || longestEffortH >= 5 || nLongEfforts >= 2) return 'aguerri';
  return 'standard';
}
function suggestTier(history) {
  return suggestTierFromHistory(history);
}

const TIER_LABELS = { standard: 'Standard', aguerri: 'Aguerri', tres_experimente: 'Très expérimenté' };
const TIER_PARAMS = {
  standard: { recupCut: 0.68, reentryBump: 0.10, easeStart: 0.65, inc5: 10, inc4: 7, incPct: 0.16 },
  aguerri: { recupCut: 0.75, reentryBump: 0.15, easeStart: 0.75, inc5: 14, inc4: 10, incPct: 0.22 },
  tres_experimente: { recupCut: 0.80, reentryBump: 0.20, easeStart: 0.85, inc5: 18, inc4: 13, incPct: 0.28 },
};

// Resolve everything derivable from the objectif form once.
function deriveObjectif(o) {
  const raceKmEq = toKmEq(o.distanceKm, o.deniveleM);
  const raceRatio = raceKmEq > 0 ? (o.deniveleM || 0) / raceKmEq : 0;
  const startKmEq = toKmEq(o.startKm, o.startDPlus) || 30;
  const startRatio = startKmEq > 0 ? (o.startDPlus || 0) / startKmEq : 0;
  const paceMinPerKmEq = (o.currentWeeklyHours && startKmEq) ? (o.currentWeeklyHours * 60) / startKmEq : DEFAULT_PACE_MIN_PER_KMEQ;

  const historyMatch = raceKmEq ? pickBestHistoryMatch(o.history, raceKmEq) : null;
  const profileRef = o.profileRef;

  let raceHoursLow, raceHoursHigh, raceHoursSource, raceHoursSourceLabel;
  if (o.raceHoursEstimate) {
    raceHoursLow = raceHoursHigh = o.raceHoursEstimate; raceHoursSource = 'manuel';
  } else if (historyMatch) {
    const r = predictFromHistoryEntry(historyMatch, raceKmEq);
    if (r) { [raceHoursLow, raceHoursHigh] = r; raceHoursSource = 'historique'; raceHoursSourceLabel = `${historyMatch.nom} (${historyMatch.date || '?'})`; }
  }
  if (raceHoursLow == null && profileRef && profileRef.refKm && profileRef.refSec && raceKmEq) {
    const r = riegelRaceHoursRange(profileRef.refKm, profileRef.refSec, raceKmEq);
    [raceHoursLow, raceHoursHigh] = r; raceHoursSource = 'profil';
  }
  // Tier is resolved here (not just left to the component) because it also
  // drives the race-time fallback band below — one experience signal, not
  // two separate "niveau" and "palier" questions. Computed from absolute
  // history, never relative to this race.
  const suggestedTier = suggestTier(o.history);
  const effectiveTier = TIER_PARAMS[o.experienceTier] ? o.experienceTier : (suggestedTier || 'standard');
  if (raceHoursLow == null && raceKmEq) {
    [raceHoursLow, raceHoursHigh] = experienceRaceHoursRange(effectiveTier, raceKmEq); raceHoursSource = 'tier';
  }
  if (raceHoursLow == null) { raceHoursLow = raceHoursHigh = 0; raceHoursSource = null; }
  const raceHours = (raceHoursLow + raceHoursHigh) / 2; // midpoint used for internal sizing only

  const discipline = o.disciplineObjectif || 'trail';
  // Road paces, derived from the reference performance (or the best history
  // match). Proposed automatically — the user may still force a goal.
  const paceRefKm = (o.profileRef && o.profileRef.refKm) || (historyMatch && historyMatch.distanceKm) || 0;
  const paceRefSec = (o.profileRef && o.profileRef.refSec) || (historyMatch && historyMatch.tempsSec) || 0;
  // Fall back to the stated goal when no reference performance exists: a plan
  // without paces is useless on the road, and the goal time is exactly what
  // the athlete is training to hold.
  let roadPaces = computeRoadPaces(paceRefKm, paceRefSec);
  let pacesFromGoal = false;
  if (!roadPaces && o.raceHoursEstimate && o.distanceKm) {
    roadPaces = computeRoadPaces(o.distanceKm, o.raceHoursEstimate * 3600);
    pacesFromGoal = !!roadPaces;
  }
  // The race-pace zone takes the name of the race being prepared: "allure
  // marathon" on a 10K plan would just be confusing.
  if (roadPaces) {
    const rp = roadProfile(o.distanceKm);
    roadPaces = { ...roadPaces, marathon: { ...roadPaces.marathon, label: rp.paceLabel } };
  }
  const goalAssessment = o.raceHoursEstimate
    ? assessGoal(paceRefKm, paceRefSec, o.distanceKm, o.raceHoursEstimate * 3600) : null;
  // Below a certain effort-distance, volume ramp simply isn't the limiting
  // factor — a short trail is trained like a road race (zones, race-pace
  // work), not by building toward a choc weekend. The engine switches by
  // itself rather than producing a nonsensical 2-week "plan".
  // V5.2: the selected discipline is the source of truth. Equivalent distance
  // may still inform sizing/strategy, but it must NEVER rewrite the user's
  // Trail choice into Route in the UI. This fixes Trail + distance/D+ reverting
  // to the road form.
  const SHORT_RACE_KMEQ = 55; // retained as a sizing reference only
  const autoRoadLogic = false;
  const effectiveDiscipline = discipline === 'route' ? 'route' : 'trail';
  const specificity = o.specificity ?? 0.75;
  // Hard daily caps, no longer asked of the user. Research is clear that
  // isolated 6-8h efforts don't buy meaningfully more than a well-managed
  // 4-5h run or back-to-backs, while costing far more in fatigue, recovery
  // and injury risk. The 10h exception exists only for the genuinely
  // ultra-specific case: near-full specificity where two days can cover the
  // whole race — that full rehearsal has a value a capped day doesn't.
  const ultraSpecific = specificity >= 0.90;
  const maxHoursPerDay = ultraSpecific ? 10 : 8;
  // Users work: a choc weekend is 2 days by default (extendable per-block for
  // holidays). Past what 2 days can hold, we don't stretch the weekend — we
  // switch to a PIC CHOC block spread over 2 full weeks.
  const chocWeekendCapHours = 2 * maxHoursPerDay;
  const wantedWeekendHours = raceHours * specificity;
  const lastWeekendHoursTarget = Math.min(wantedWeekendHours, chocWeekendCapHours);
  // Use the pace implied by the race itself (hours ÷ km-éq), not the athlete's
  // average weekly training pace — otherwise a higher starting volume (at the
  // same weekly hours) makes paceMinPerKmEq faster, which paradoxically
  // inflates the peak target and can make weeksNeeded go UP as the starting
  // point improves.
  const ultraPaceMinPerKmEq = raceKmEq ? (raceHours * 60) / raceKmEq : paceMinPerKmEq;
  // PIC CHOC: when the wanted volume exceeds what a 2-day weekend can hold,
  // it's delivered as two consecutive high-volume WEEKS (each containing a
  // normal 2-day weekend at the chosen specificity), not as one oversized
  // weekend. So the weekly peak is sized for one such week, not for the
  // impossible single-week version of the whole thing.
  const strategy = disciplineStrategy(effectiveDiscipline);
  const picChocLikely = strategy.usesPicChoc && wantedWeekendHours > chocWeekendCapHours;
  // A PIC CHOC week targets ~120% of race duration at full specificity — the
  // point of the block is to hold MORE than race volume for two consecutive
  // weeks, which is what builds the capacity to absorb the race itself. The
  // previous formula took min(1.20 × raceHours, wantedWeekendHours), and since
  // wantedWeekendHours = specificity × raceHours, at 100% specificity it
  // collapsed back to 1.0 × raceHours — so asking for 100% could never produce
  // the intended 120% block.
  const picChocWeeklyHours = picChocLikely ? raceHours * 1.20 * specificity : 0;
  const effectiveWeekendHours = picChocLikely ? Math.max(lastWeekendHoursTarget, picChocWeeklyHours * 0.65) : lastWeekendHoursTarget;
  const lastWeekendKmEq = (effectiveWeekendHours * 60) / (ultraPaceMinPerKmEq || paceMinPerKmEq);
  // The weekend-derived value collapses to a constant once the hour cap binds
  // (any race past ~100km) — an 170km race would otherwise get the same peak
  // as a 100km one. The weekly peak must keep scaling with the race itself
  // even when the weekend physically can't: the rest of the week carries the
  // specificity the capped weekend no longer can.
  const isRoad = !strategy.usesChocWeekends;
  const recommendedPeakKmEq = isRoad
    ? roadRecommendedPeak(o.distanceKm || raceKmEq, effectiveTier)
    : Math.round(Math.max(lastWeekendKmEq / 0.80, raceKmEq * 0.80));
  const peakKmEq = o.peakKmEq || recommendedPeakKmEq;
  // A peak that does NOT depend on the selected tier. When there's no history
  // and no target time, raceHours comes from the tier's pace band, so the peak
  // (and every week count derived from it) would shift as the user clicks
  // through tiers — making the comparison meaningless. This reference pins the
  // estimate to the suggested tier (or a neutral one) so the three rows differ
  // only by ramp speed, which is the thing actually being compared.
  const referenceTier = suggestedTier || 'aguerri';
  let referencePeakKmEq = peakKmEq;
  if (!o.peakKmEq && raceHoursSource === 'tier' && raceKmEq) {
    const [rl, rh] = experienceRaceHoursRange(referenceTier, raceKmEq);
    const refHours = (rl + rh) / 2;
    const refPace = (refHours * 60) / raceKmEq;
    const refWanted = refHours * specificity;
    const refEffective = (strategy.usesPicChoc && refWanted > chocWeekendCapHours)
      ? Math.max(Math.min(refWanted, chocWeekendCapHours), Math.min(refHours * 1.20, refWanted) * 0.65)
      : Math.min(refWanted, chocWeekendCapHours);
    referencePeakKmEq = Math.round(Math.max(((refEffective * 60) / refPace) / 0.80, raceKmEq * 0.80));
  }
  const habitualKmEq = toKmEq(o.habitualKm, o.habitualDPlus);
  const currentRoadGoalTimeSec = paceRefKm && paceRefSec && o.distanceKm
    ? riegelSecondsFor(paceRefKm, paceRefSec, o.distanceKm) : 0;
  const roadPreparation = effectiveDiscipline === 'route' ? estimateRoadPreparationWeeks({
    distance: o.distanceKm, startKmEq, peakKmEq, trainingDays: o.trainingDaysPerWeek || 5, tier: effectiveTier,
    currentTimeSec: currentRoadGoalTimeSec, goalTimeSec: o.raceHoursEstimate ? o.raceHoursEstimate * 3600 : 0,
    hasReliableBenchmark: !!(paceRefKm && paceRefSec), taperWeeks: o.taperWeeks,
  }) : null;
  return { raceKmEq, raceRatio, startKmEq, startRatio, paceMinPerKmEq, ultraPaceMinPerKmEq, raceHours, raceHoursLow, raceHoursHigh, raceHoursSource, raceHoursSourceLabel,
    discipline, effectiveDiscipline, autoRoadLogic, strategy, ultraSpecific, roadPaces, pacesFromGoal, goalAssessment, roadProfileInfo: roadProfile(o.distanceKm), paceRefKm, paceRefSec, chocWeekendCapHours, referencePeakKmEq, picChocLikely, picChocWeeklyHours, wantedWeekendHours,
    maxHoursPerDay, specificity, lastWeekendHoursTarget, lastWeekendKmEq, recommendedPeakKmEq, peakKmEq, habitualKmEq, suggestedTier, effectiveTier, roadPreparation };
}

// Growth in km-éq per build week. Flat absolute increments spread over 4-5
// sessions are cheap per run; tapering only starts once close to the ceiling.
function kmEqAfterGrowth(kmEq, peakKmEq, trainingDays, tier) {
  const p = TIER_PARAMS[tier] || TIER_PARAMS.standard;
  let inc;
  if (trainingDays >= 5) inc = p.inc5;
  else if (trainingDays >= 4) inc = p.inc4;
  else inc = kmEq * p.incPct;
  if (peakKmEq) {
    const ratio = kmEq / peakKmEq;
    if (ratio > p.easeStart) {
      const t = Math.min(1, (ratio - p.easeStart) / (1 - p.easeStart));
      inc = inc * (1 - t) + (peakKmEq * 0.02) * t;
    }
  }
  return kmEq + inc;
}

// Runs the same charge/choc/récup/reprise cycle forward from a starting level
// until it reaches the target peak, to answer "how many weeks does this
// actually take" — independent of any race date. Used to back into an ideal
// start date rather than just flagging today's plan as too tight.
function weeksToReachPeak(startKmEq, peakKmEq, trainingDays, tier) {
  if (!peakKmEq || startKmEq >= peakKmEq) return 0;
  const p = TIER_PARAMS[tier] || TIER_PARAMS.standard;
  let kmEq = startKmEq;
  let lastCharge = null;
  for (let i = 0; i < 300; i++) {
    if (i > 0) {
      const cyclePos = i % 4;
      if (cyclePos === 3) kmEq *= p.recupCut;
      else if (cyclePos === 0) kmEq = lastCharge != null ? lastCharge : kmEq * (1 + p.reentryBump);
      else kmEq = kmEqAfterGrowth(kmEq, peakKmEq, trainingDays, tier);
      if (cyclePos === 1) lastCharge = kmEq;
      kmEq = Math.min(kmEq, peakKmEq);
    }
    if (kmEq >= peakKmEq - 0.5) return i;
  }
  return 300;
}


// V5.2 Route preparation-duration model. This wraps the proven V4 volume
// progression instead of replacing it. Volume, speed and race-specificity can
// overlap, so the limiting adaptation is the maximum of the three; taper is
// then added separately. The coefficients below are product-model parameters,
// not universal physiological constants.
const ROAD_SPEED_COEFFICIENT = {
  standard: 0.70,
  aguerri: 0.55,
  tres_experimente: 0.40,
};
const ROAD_SPECIFICITY_WEEKS = { '10k': 2, semi: 4, marathon: 6 };
const ROAD_SPECIFICITY_COEFFICIENT = {
  standard: 1.00,
  aguerri: 0.85,
  tres_experimente: 0.70,
};
const ROAD_MAX_SPEED_DEFICIT = 0.20;
const ROAD_MIN_PREP_WEEKS = 4;
const ROAD_MAX_PREP_WEEKS = 24;

function estimateRoadPreparationWeeks({
  distance, startKmEq, peakKmEq, trainingDays, tier,
  currentTimeSec, goalTimeSec, hasReliableBenchmark, taperWeeks,
}) {
  const safeTier = TIER_PARAMS[tier] ? tier : 'standard';
  const profile = roadProfile(distance);
  const volumeWeeks = weeksToReachPeak(startKmEq, peakKmEq, trainingDays, safeTier);
  const speedGap = currentTimeSec && goalTimeSec
    ? Math.max(0, (currentTimeSec - goalTimeSec) / goalTimeSec)
    : 0;
  const boundedGap = Math.min(ROAD_MAX_SPEED_DEFICIT, speedGap);
  const speedWeeks = hasReliableBenchmark && speedGap > 0
    ? Math.ceil(100 * boundedGap * ROAD_SPEED_COEFFICIENT[safeTier])
    : 0;
  const specificityBase = ROAD_SPECIFICITY_WEEKS[roadDistanceKey(distance)] || 4;
  const specificityWeeks = Math.ceil(specificityBase * ROAD_SPECIFICITY_COEFFICIENT[safeTier]);
  const adaptationWeeks = Math.max(volumeWeeks, speedWeeks, specificityWeeks);
  const requestedTaper = Math.max(0, Number(taperWeeks) || 0);
  const profileTaper = profile ? profile.taperWeeks : 2;
  const effectiveTaperWeeks = requestedTaper > 0 ? requestedTaper : profileTaper;
  const rawTotal = adaptationWeeks + effectiveTaperWeeks;
  const totalWeeks = Math.min(ROAD_MAX_PREP_WEEKS, Math.max(ROAD_MIN_PREP_WEEKS, rawTotal));
  const limitingFactor = volumeWeeks >= speedWeeks && volumeWeeks >= specificityWeeks
    ? 'volume'
    : speedWeeks >= specificityWeeks ? 'speed' : 'specificity';
  return {
    totalWeeks, volumeWeeks, speedWeeks, specificityWeeks,
    taperWeeks: effectiveTaperWeeks, speedGap,
    goalStatus: speedGap > ROAD_MAX_SPEED_DEFICIT ? 'ambitious' : 'realistic',
    limitingFactor, hasReliableBenchmark: !!hasReliableBenchmark,
  };
}

// Split the available weeks into macrocycles. The taper is derived from the
// weekly-phase logic (taperWeeks) so the two layers can't disagree; the rest
// is split ~50/35 between Développement and Spécifique, with the optional
// Anticipation block carved OUT OF Développement rather than added on top —
// it must never inflate the calendar just to fill it.
function buildMacrocycles(totalWeeks, taperWeeks, slackWeeks) {
  const buildWeeks = Math.max(0, totalWeeks - taperWeeks);
  if (buildWeeks <= 0) return { anticipationEnd: 0, developpementEnd: 0, specifiqueEnd: 0 };
  // Nominal 50/35 of the whole plan, renormalised over the build weeks.
  let devWeeks = Math.round(buildWeeks * (50 / 85));
  let anticipationWeeks = 0;
  if (slackWeeks > 3 && devWeeks >= 6) {
    // Consumes part of Développement (spec §6), capped so development keeps
    // enough room to actually build a base.
    anticipationWeeks = Math.min(4, Math.floor(devWeeks * 0.35));
    devWeeks -= anticipationWeeks;
  }
  const anticipationEnd = anticipationWeeks;
  const developpementEnd = anticipationEnd + devWeeks;
  return { anticipationEnd, developpementEnd, specifiqueEnd: buildWeeks };
}
function macrocycleAt(i, m, buildWeeks) {
  if (i >= buildWeeks) return 'affutage';
  if (i < m.anticipationEnd) return 'anticipation';
  if (i < m.developpementEnd) return 'developpement';
  return 'specifique';
}

function buildPeriodizationPlan(objectif) {
  if (!objectif || !objectif.date) return [];
  const raceDate = parseISODate(objectif.date);
  if (!raceDate) return [];
  // Never start a plan on a Monday that has already passed: generating on a
  // Wednesday would otherwise put week 1 two days in the past. The plan starts
  // on the upcoming Monday (today counts if it IS Monday). An explicit
  // planStartDate overrides this, which is how "start at the optimal date"
  // rather than "start now" is expressed.
  const todayMonday = getMonday(new Date());
  const naturalStart = (new Date().getDay() === 1) ? todayMonday : addDays(todayMonday, 7);
  const explicitStart = objectif.planStartDate ? getMonday(parseISODate(objectif.planStartDate)) : null;
  const startMonday = (explicitStart && explicitStart > naturalStart) ? explicitStart : naturalStart;
  const raceMonday = getMonday(raceDate);
  let totalWeeks = Math.round((raceMonday - startMonday) / (7 * 24 * 3600 * 1000));
  if (totalWeeks < 0) return [];
  const D = deriveObjectif(objectif);
  // Road builds are 16-20 weeks. Beyond that you're not training for the race
  // any more, you're just running — so a road plan starts later rather than
  // padding months of filler. (Ultra is the opposite: the ramp itself can
  // legitimately take a year.)
  let roadStartMonday = startMonday;
  if (!D.strategy.usesChocWeekends) {
    const rp = roadProfile(objectif.distanceKm);
    if (totalWeeks > rp.maxWeeks) {
      roadStartMonday = addDays(raceMonday, -rp.maxWeeks * 7);
      totalWeeks = rp.maxWeeks;
    }
  }
  // A PIC CHOC block is the single largest stimulus of the plan, held for two
  // consecutive weeks. Two taper weeks aren't enough to absorb it, so the
  // taper stretches to at least 3 when a block is present (still capped by
  // what the calendar allows).
  const requestedTaper = objectif.taperWeeks ?? 2;
  // Road: a 3-week taper is the reference (volume -25/-50/-75%, intensity kept).
  const baseTaper = !D.strategy.usesChocWeekends
    ? Math.max(requestedTaper, roadProfile(objectif.distanceKm).taperWeeks)
    : requestedTaper;
  const taperWeeks = Math.max(0, Math.min(D.picChocLikely ? Math.max(baseTaper, 3) : baseTaper, totalWeeks));
  const tier = D.effectiveTier;
  const tierParams = TIER_PARAMS[tier];
  const trainingDays = objectif.trainingDaysPerWeek || 5;
  const recupCut = tierParams.recupCut;
  const firstReentryBump = tierParams.reentryBump;
  const lastBuildIndex = totalWeeks - taperWeeks - 1; // last week before taper
  const chocPositions = [];
  for (let i = 0; i <= lastBuildIndex; i++) if (i % 4 === 2) chocPositions.push(i);
  const nChoc = chocPositions.length;
  // PIC CHOC is planned up-front, not improvised: when the wanted volume
  // exceeds what a 2-day weekend can hold, the LAST choc slot becomes a
  // two-week block (that week + the following one). Each of those weeks runs
  // its own normal 2-day weekend at the chosen specificity — users work, so
  // we never ask for 4-6 consecutive big days. What makes it a "PIC CHOC" is
  // the weekly volume (up to ~120% of race time), sustained across 2 weeks.
  let picChocStart = null;
  if (D.picChocLikely && lastBuildIndex >= 1) {
    // The block should culminate the preparation: place it so its second week
    // is the last build week before the taper.
    picChocStart = lastBuildIndex - 1;
    // ...but never let it open on the week right after a recovery trough
    // (cyclePos 3), which would force the peak of the whole plan to start
    // from the lowest point of a cycle.
    if (picChocStart > 1 && (picChocStart - 1) % 4 === 3) picChocStart -= 1;
  }
  // A transition block ~2 months earlier. Reaching the final block in one jump
  // is what made it either violent or unreachable; two staged blocks teach the
  // body to hold a big WEEK (not just a big weekend) before the real one.
  let picChocTransitionStart = null;
  if (picChocStart != null) {
    const candidate = picChocStart - 8;
    // Needs room for its own 2 weeks plus a recovery week before the final block.
    if (candidate >= 2 && candidate + 1 < picChocStart - 1) picChocTransitionStart = candidate;
  }
  const picChocWeeks = picChocStart != null ? [picChocStart, picChocStart + 1] : [];
  const isRoadPlan = !D.strategy.usesChocWeekends;
  // Macrocycle layer (independent of the weekly phase cycle).
  const buildWeeksCount = Math.max(0, totalWeeks - taperWeeks);
  // Slack = how much longer the calendar is than the preparation strictly
  // needs. Computed here rather than passed in, so the engine stays complete
  // on its own.
  const roadPrep = isRoadPlan ? estimateRoadPreparationWeeks({
    distance: objectif.distanceKm, startKmEq: D.startKmEq, peakKmEq: D.peakKmEq,
    trainingDays: objectif.trainingDaysPerWeek || 5, tier,
    currentTimeSec: D.paceRefKm && D.paceRefSec && objectif.distanceKm ? riegelSecondsFor(D.paceRefKm, D.paceRefSec, objectif.distanceKm) : 0, goalTimeSec: objectif.raceHoursEstimate ? objectif.raceHoursEstimate * 3600 : 0,
    hasReliableBenchmark: !!(D.paceRefKm && D.paceRefSec), taperWeeks,
  }) : null;
  const weeksNeeded = roadPrep ? roadPrep.totalWeeks : weeksToReachPeak(D.startKmEq, D.peakKmEq, objectif.trainingDaysPerWeek || 5, tier) + taperWeeks;
  const slackWeeks = totalWeeks - weeksNeeded;
  const macroBounds = buildMacrocycles(totalWeeks, taperWeeks, slackWeeks);
  const picChocTransitionWeeks = picChocTransitionStart != null ? [picChocTransitionStart, picChocTransitionStart + 1] : [];

  let kmEq = D.startKmEq;
  let lastCharge = null;
  let peakSnapshot = null;
  let deepRecupNext = false;
  const weeks = [];

  // km and D+ grow as two separate quantities. Each week, the INCREMENT in
  // total effort (kmEq) is split between them in proportion to how far each
  // still is from the race's own km/D+ — so if D+ is badly behind (e.g. 80
  // km/1000m start vs a 100km/6000m race), almost all new growth goes to D+
  // until it catches up, rather than growing both at a fixed ratio dictated
  // by how many weeks have passed. Cutbacks (recup/taper) scale both down
  // proportionally, preserving whatever mix has been reached so far.
  let curKm = splitKmEq(D.startKmEq, D.startRatio).km;
  let curDPlus = splitKmEq(D.startKmEq, D.startRatio).dplus;
  let prevKmEq = D.startKmEq;
  const raceKm = objectif.distanceKm || 0;
  const raceDPlus = objectif.deniveleM || 0;
  let picChocPeakKmEq = null; // the sustained weekly level inside the block
  let deferredDeepCut = false; // set when a PIC CHOC block just ended

  for (let i = 0; i <= totalWeeks; i++) {
    const monday = addDays(roadStartMonday, i * 7);
    const weeksBeforeRace = totalWeeks - i;
    let phase, weekKmEq, note = null;
    let isTransitionBlock = false;
    const picChocPart = picChocWeeks.indexOf(i) >= 0 ? picChocWeeks.indexOf(i) + 1 : 0;
    const picChocTransPart = picChocTransitionWeeks.indexOf(i) >= 0 ? picChocTransitionWeeks.indexOf(i) + 1 : 0;

    if (weeksBeforeRace === 0) {
      phase = 'course';
      weekKmEq = (peakSnapshot || kmEq) * 0.15;
    } else if (weeksBeforeRace <= taperWeeks) {
      if (!peakSnapshot) peakSnapshot = kmEq;
      const taperIndex = taperWeeks - weeksBeforeRace;
      if (isRoadPlan) {
        // Road reference taper: volume -25% / -50% / -75% across three weeks,
        // intensity deliberately preserved (fewer reps, same paces). Race-day
        // legs are made in the taper, not in the peak weeks.
        const ROAD_TAPER = [0.75, 0.50, 0.25];
        const idxFromEnd = weeksBeforeRace - 1; // 0 = week before the race
        const f = ROAD_TAPER[Math.min(ROAD_TAPER.length - 1, Math.max(0, ROAD_TAPER.length - 1 - idxFromEnd))];
        weekKmEq = peakSnapshot * f;
        note = `Affûtage — volume à ${Math.round(f * 100)} % du pic, intensité maintenue`;
      } else {
        weekKmEq = peakSnapshot * Math.max(0.3, 0.65 - taperIndex * 0.2);
      }
      phase = 'affutage';
    } else if (picChocPart > 0 || picChocTransPart > 0) {
      // Inside a PIC CHOC block: both weeks sit at the same sustained high
      // level, held with no cutback between them. The transition block aims
      // lower (~75%) — its job is to teach the body to hold a big WEEK, so the
      // final block isn't the first time that ever happens.
      const isTransition = picChocTransPart > 0;
      const part = isTransition ? picChocTransPart : picChocPart;
      if (part === 1) {
        const targetHours = (D.picChocWeeklyHours || 0) * (isTransition ? 0.75 : 1);
        const fromHours = targetHours > 0 ? (targetHours * 60) / (D.ultraPaceMinPerKmEq || D.paceMinPerKmEq) : 0;
        const ideal = isTransition ? Math.max(fromHours, (D.peakKmEq || 0) * 0.8) : Math.max(fromHours, D.peakKmEq || 0);
        // The block must still be REACHED, not teleported to. Jumping straight
        // to the theoretical target produced spikes of +40% over the previous
        // build week — precisely the acute-load pattern injury research flags.
        // But the reference is the highest level actually BUILT (lastCharge),
        // not the week immediately before: the block often lands right after a
        // recovery week, and anchoring on that trough would collapse the peak
        // of the plan to below what the athlete already handled.
        const builtLevel = Math.max(lastCharge || 0, kmEq);
        const reachable = kmEqAfterGrowth(builtLevel, ideal, trainingDays, tier) * 1.08;
        picChocPeakKmEq = Math.min(ideal, Math.max(builtLevel, reachable));
        const jump = kmEq > 0 ? Math.round((picChocPeakKmEq / kmEq - 1) * 100) : 0;
        note = isTransition
          ? `PIC CHOC de transition — semaine 1/2, préparation à tenir un gros volume hebdo${jump > 0 ? ` (+${jump}%)` : ''}`
          : `Bloc PIC CHOC — semaine 1/2, volume maximal de la prépa${jump > 0 ? ` (+${jump}% vs semaine précédente)` : ''}`;
      } else {
        note = isTransition
          ? 'PIC CHOC de transition — semaine 2/2, aucune coupure entre les deux'
          : 'Bloc PIC CHOC — semaine 2/2, aucune coupure entre les deux';
        deferredDeepCut = true;
      }
      kmEq = picChocPeakKmEq;
      weekKmEq = kmEq;
      phase = 'picchoc';
      isTransitionBlock = isTransition;
    } else {
      const cyclePos = i % 4;
      if (i > 0) {
        if (cyclePos === 3) {
          const cut = (deepRecupNext || deferredDeepCut) ? Math.min(recupCut, 0.68) : recupCut;
          if (deferredDeepCut) note = 'Récupération renforcée après le bloc PIC CHOC';
          else if (deepRecupNext) note = 'Récup renforcée après un très gros week-end';
          kmEq *= cut; deepRecupNext = false; deferredDeepCut = false;
        } else if (cyclePos === 0) {
          if (deferredDeepCut) {
            kmEq = (lastCharge != null ? lastCharge : kmEq) * Math.min(recupCut, 0.68);
            note = 'Récupération différée après le bloc PIC CHOC';
            deferredDeepCut = false;
          } else {
            // Return to the level held before the recovery week. This looks
            // like a big week-on-week jump, but it isn't an acute overload:
            // the body was already at this level two weeks ago and chronic
            // load is unchanged. Capping it here (a previous attempt) fought
            // the recovery cut and made every cycle lose ground, so the plan
            // plateaued below its own target peak.
            kmEq = lastCharge != null ? lastCharge : kmEq * (1 + firstReentryBump);
          }
        } else {
          kmEq = kmEqAfterGrowth(kmEq, D.peakKmEq, trainingDays, tier);
        }
        if (cyclePos === 1) lastCharge = kmEq;
        if (D.peakKmEq) kmEq = Math.min(kmEq, D.peakKmEq);
      }
      phase = cyclePos === 0 ? 'reprise' : cyclePos === 1 ? 'charge' : cyclePos === 2 ? (isRoadPlan ? 'charge' : 'choc') : 'recup';
      weekKmEq = kmEq;
    }

    // Allocate this week's km-éq to km vs D+.
    const deltaKmEq = weekKmEq - prevKmEq;
    if (deltaKmEq >= 0) {
      const remainingKm = Math.max(0, raceKm - curKm);
      const remainingDPlusKmEq = Math.max(0, (raceDPlus - curDPlus) / 100);
      const totalRemaining = remainingKm + remainingDPlusKmEq;
      if (totalRemaining > 0.01) {
        curKm += deltaKmEq * (remainingKm / totalRemaining);
        curDPlus += deltaKmEq * (remainingDPlusKmEq / totalRemaining) * 100;
      } else {
        // Both already at or beyond the race's own numbers — grow evenly.
        curKm += deltaKmEq * 0.7;
        curDPlus += deltaKmEq * 0.3 * 100;
      }
    } else {
      const factor = prevKmEq > 0 ? weekKmEq / prevKmEq : 1;
      curKm *= factor; curDPlus *= factor;
    }
    curKm = Math.max(0, curKm); curDPlus = Math.max(0, curDPlus);
    prevKmEq = weekKmEq;

    const km = curKm, dplus = curDPlus;
    const displayRatio = (km + dplus / 100) > 0 ? dplus / (km + dplus / 100) : 0;
    const hours = (weekKmEq * D.paceMinPerKmEq) / 60;
    const w = {
      monday, weekKey: weekKey(monday), phase, weeksBeforeRace, note,
      targetKmEq: Math.round(weekKmEq), targetVolumeKm: Math.round(km), targetDPlus: Math.round(dplus),
      targetHours: Math.round(hours * 10) / 10, ratio: Math.round(displayRatio),
      // True when the week sits at the plan's ceiling. Without this, a
      // "charge" week and the following "choc" week showing the same volume
      // looks like a bug rather than "you've reached peak volume".
      macrocycle: weeksBeforeRace === 0 ? 'affutage' : macrocycleAt(i, macroBounds, buildWeeksCount),
      roadPrep: roadPrep || null,
      atPeak: D.peakKmEq > 0 && weekKmEq >= D.peakKmEq - 0.5 && phase !== 'affutage' && phase !== 'course' && phase !== 'recup',
      isTransitionBlock,
    };

    if (phase === 'choc' || phase === 'picchoc') {
      const isPic = phase === 'picchoc';
      const isTransPic = isPic && isTransitionBlock;
      // Weekend = growing share of the week: 60% at the first choc -> 80% at
      // the last. Inside a PIC CHOC block the weekend is a normal 2-day one
      // (65% of a much bigger week) — the block's intensity comes from the
      // weekly volume sustained across 2 weeks, not from extra days.
      const k = chocPositions.indexOf(i);
      const t = nChoc > 1 && k >= 0 ? k / (nChoc - 1) : 1;
      const frac = isPic ? 0.65 : 0.60 + 0.20 * t;
      const weekendKmEq = weekKmEq * frac;
      const weekendHours = (weekendKmEq * (D.ultraPaceMinPerKmEq || D.paceMinPerKmEq)) / 60;
      // Default 2 days (people work). An explicit per-block override can
      // extend to 3-4 days when the user is on holiday.
      const override = (objectif.chocDayOverrides || {})[weekKey(monday)];
      const nDays = override && override >= 2 && override <= 4 ? override : 2;
      const SPLITS = { 2: [0.55, 0.45], 3: [0.40, 0.33, 0.27], 4: [0.30, 0.27, 0.23, 0.20] };
      const splits = SPLITS[nDays];
      // Hard daily ceiling: never schedule a day above the cap. If the split
      // would exceed it, the weekend total is trimmed to what the days can
      // legally hold — the remainder stays in the week's other sessions.
      const maxSplit = Math.max(...splits);
      const cappedWeekendHours = Math.min(weekendHours, D.maxHoursPerDay / maxSplit);
      const perDayHours = splits.map(s => Math.round(cappedWeekendHours * s * 10) / 10);
      const maxDay = Math.max(...perDayHours);
      const cappedKmEq = weekendKmEq * (weekendHours > 0 ? cappedWeekendHours / weekendHours : 1);
      const fracAdj = frac * (weekendHours > 0 ? cappedWeekendHours / weekendHours : 1);
      w.weekend = {
        isPicChoc: isPic, isTransition: isTransPic, part: isPic ? (isTransPic ? picChocTransPart : picChocPart) : undefined,
        kmEq: Math.round(cappedKmEq), km: Math.round(km * fracAdj), dplus: Math.round(dplus * fracAdj),
        hours: Math.round(cappedWeekendHours * 10) / 10, days: nDays, perDayHours, splits,
        canExtend: true, extended: !!override,
        pctOfRace: D.raceHours ? Math.round((cappedWeekendHours / D.raceHours) * 100) : null,
        weekPctOfRace: D.raceHours ? Math.round(((weekKmEq * (D.ultraPaceMinPerKmEq || D.paceMinPerKmEq) / 60) / D.raceHours) * 100) : null,
        overMax: maxDay > D.maxHoursPerDay + 0.05,
        isLast: isPic ? picChocPart === 2 : (k === nChoc - 1 && !D.picChocLikely),
      };
      if (cappedWeekendHours > 16) deepRecupNext = true;
    }
    weeks.push(w);
  }
  return weeks;
}

const PHASE_LABELS = { reprise: 'Reprise douce', charge: 'Charge', choc: 'Week-end choc', picchoc: 'PIC CHOC', recup: 'Récupération', affutage: 'Affûtage', course: 'Semaine de course' };

function pickTemplateByType(library, type) {
  const opts = library.filter(t => t.type === type);
  return opts.length ? opts[0].id : null;
}

// weekend: the w.weekend object from the plan (choc weeks only). The choc week
// is weekend-dominated: 2-3 long days plus a stripped-down midweek.
// Relative weight of each session type within a week — used to split the
// week's computed volume across its sessions. Long runs carry much more than
// recovery jogs, so a fixed per-template distance would never match the plan.
const SESSION_WEIGHTS = { 'Sortie longue': 3.0, 'Sortie longue spécifique': 3.2, 'Rando-course': 2.2, 'Seuil': 1.4, 'Fractionné long': 1.3, 'Fractionné court': 1.1, 'Côtes': 1.2, 'Montée / concentrique': 1.3, 'Descente / excentrique': 1.2, 'EF': 1.0, 'Récupération': 0.6, 'Autre': 1.0 };
// What a weekday slot can realistically hold, in hours, given the user works.
const SLOT_LABELS = { morning: 'Matin', midday: 'Midi', evening: 'Soir', free: 'Libre', none: '—' };
const DAY_CAPACITY = { none: 0, morning: 1.25, midday: 1.0, evening: 1.5, free: 24 };
// Availability is stored per day as either a single slot string (legacy) or an
// array of slots. Multiple slots matter for high volume: without a second slot
// there's simply nowhere to put the extra hours on a working day.
function daySlots(availability, dayKey) {
  const a = (availability || {})[dayKey];
  if (a == null) return (dayKey === 'sam' || dayKey === 'dim') ? ['free'] : ['evening'];
  return Array.isArray(a) ? a.filter(s => s && s !== 'none') : (a === 'none' ? [] : [a]);
}
// ============================================================================
// V4 capacity & allocation
//
// The ordering here IS the spec's constraint hierarchy: safety and real
// availability come first, then the session/daily caps, then the week's
// structure, and only last the volume target. A week may legitimately come in
// under target — when it does, it says so rather than silently overflowing.
// ============================================================================

// Hours a given day can hold. Weekdays are bound by the centralised caps;
// weekends deliberately are not — that's where ultra volume lives.
function dayCapacityHours(availability, dayKey) {
  const slots = daySlots(availability, dayKey);
  if (!slots.length) return 0;
  if (isWeekendDay(dayKey)) {
    // "Libre" on a weekend means open for a long run — but not unbounded, or
    // capacity maths would conclude a week can absorb 48h and doubles would
    // never look necessary.
    if (slots.indexOf('free') >= 0) return WEEKEND_PLANNING_CAP_HOURS;
    return slots.reduce((s, sl) => s + (DAY_CAPACITY[sl] != null ? DAY_CAPACITY[sl] : 1.5), 0);
  }
  if (slots.indexOf('free') >= 0) return MAX_DAILY_HOURS;
  const raw = slots.reduce((s, sl) => s + (DAY_CAPACITY[sl] != null ? Math.min(DAY_CAPACITY[sl], MAX_SESSION_HOURS) : 1.5), 0);
  return Math.min(raw, MAX_DAILY_HOURS);
}

// How many sessions a weekday may hold, before knowing whether doubles are
// actually needed. A "free" weekday can host two; otherwise it's one per slot.
function daySlotCount(availability, dayKey) {
  const slots = daySlots(availability, dayKey);
  if (!slots.length) return 0;
  if (isWeekendDay(dayKey)) return slots.indexOf('free') >= 0 ? 2 : slots.length;
  if (slots.indexOf('free') >= 0) return MAX_SESSIONS_PER_DAY;
  return Math.min(slots.length, MAX_SESSIONS_PER_DAY);
}

// Capacity of a week with ONE session per weekday (weekend excluded from the
// session cap). Used to decide whether doubles are required at all.
function calculateWeekCapacity(availability) {
  let singleWeekday = 0, doubleWeekday = 0, weekendH = 0;
  DAYS.forEach(d => {
    const cap = dayCapacityHours(availability, d.key);
    if (cap <= 0) return;
    if (isWeekendDay(d.key)) { weekendH += cap; return; }
    singleWeekday += Math.min(cap, MAX_SESSION_HOURS);
    doubleWeekday += cap;
  });
  return {
    singleOnly: singleWeekday + weekendH,
    withDoubles: doubleWeekday + weekendH,
    weekendHours: weekendH,
    weekdayHoursSingle: singleWeekday,
    weekdayHoursDouble: doubleWeekday,
  };
}

// Doubles are a response to a real constraint, never a reflex because two
// slots exist. The question is asked at the PEAK week: if the hardest week of
// the plan fits with one session a day, the plan never needs doubles.
function determineDoubleSessionNeed(peakHours, availability) {
  const cap = calculateWeekCapacity(availability);
  const required = peakHours > cap.singleOnly + 0.01;
  const possible = cap.withDoubles > cap.singleOnly + 0.01;
  return {
    required,
    possible,
    // Needed but impossible: the plan will be trimmed and the user warned.
    impossible: required && !possible,
    capacity: cap,
  };
}

// Target share of the week that should land on the weekend.
function weekendTargetPct(phase) {
  if (phase === 'choc' || phase === 'picchoc') return 0.70;   // 60-80% band
  if (phase === 'recup' || phase === 'affutage' || phase === 'course') return 0.40;
  return 0.45;                                                 // 40-50% band
}


// Pick the best available template for a wanted type, falling back through
// the macrocycle's preferred types before settling for anything runnable.
// Session blueprints. The plan decides what it NEEDS; the library is a
// reference catalogue, not a gatekeeper. Previously a missing "Côtes" entry
// silently downgraded the session to EF — the plan was effectively a slave to
// whatever happened to be in the library. Now the plan generates the session
// and only uses the library when it holds a genuine match.
const ROAD_BLUEPRINTS = {
  'EF':                       { zone: 'easy',       structure: 'continu' },
  'Récupération':             { zone: 'easy',       structure: 'continu' },
  'Sortie longue':            { zone: 'easy',       structure: 'continu' },
  'Sortie longue progressive':{ zone: 'easy',       structure: 'progressif', finishZone: 'marathon', finishShare: 0.28 },
  'Allure spécifique':        { zone: 'marathon',   structure: 'interval', progression: 'mp' },
  'Seuil':                    { zone: 'threshold',  structure: 'interval', progression: 'threshold' },
  'Fractionné long':          { zone: 'interval',   structure: 'interval', repeat: 6, workMin: 4, restMin: 2 },
  'Fractionné court':         { zone: 'repetition', structure: 'interval', repeat: 10, workMin: 1.5, restMin: 1.5 },
};

const SESSION_BLUEPRINTS = {
  'EF': { terrain: 'vallonne', specificite: 'mixte', hrLow: 125, hrHigh: 148, structure: 'continu' },
  'Récupération': { terrain: 'plat', specificite: 'aucune', hrLow: 100, hrHigh: 128, structure: 'continu' },
  'Sortie longue': { terrain: 'vallonne', specificite: 'mixte', hrLow: 125, hrHigh: 150, structure: 'continu' },
  'Sortie longue spécifique': { terrain: 'montagne', specificite: 'mixte', hrLow: 120, hrHigh: 148, structure: 'continu' },
  'Rando-course': { terrain: 'montagne', specificite: 'concentrique', hrLow: 125, hrHigh: 152, structure: 'continu' },
  'Seuil': { terrain: 'vallonne', specificite: 'mixte', hrLow: 158, hrHigh: 172, structure: 'interval', repeat: 3, workMin: 10, restMin: 5 },
  'Côtes': { terrain: 'montee', specificite: 'concentrique', hrLow: 155, hrHigh: 170, structure: 'interval', repeat: 6, workMin: 4, restMin: 3 },
  'Montée / concentrique': { terrain: 'montee', specificite: 'concentrique', hrLow: 155, hrHigh: 170, structure: 'interval', repeat: 4, workMin: 12, restMin: 6 },
  'Descente / excentrique': { terrain: 'descente', specificite: 'excentrique', hrLow: 130, hrHigh: 155, structure: 'interval', repeat: 6, workMin: 4, restMin: 6 },
  'Fractionné court': { terrain: 'vallonne', specificite: 'mixte', hrLow: 165, hrHigh: 182, structure: 'interval', repeat: 10, workMin: 1, restMin: 2 },
  'Fractionné long': { terrain: 'vallonne', specificite: 'mixte', hrLow: 155, hrHigh: 170, structure: 'interval', repeat: 5, workMin: 6, restMin: 3 },
};

// Build a session of the requested type, scaled to the planned duration.
// Road sessions are built around PACE, and the plan's progression index decides
// how demanding the key session is this week.
function generateRoadSession(wantedType, minutes, km, paces, progressIdx, raceKm) {
  const distKey = roadDistanceKey(raceKm);
  const MP_PROGRESSION = MP_PROGRESSION_BY_DISTANCE[distKey];
  const THRESHOLD_PROGRESSION = THRESHOLD_PROGRESSION_BY_DISTANCE[distKey];
  const racePaceLabel = ROAD_DISTANCE_PROFILES[distKey].paceLabel.toLowerCase();
  const racePaceZone = ROAD_DISTANCE_PROFILES[distKey].racePaceZone;
  const bp = ROAD_BLUEPRINTS[wantedType] || ROAD_BLUEPRINTS['EF'];
  const zonePace = (z) => (paces && paces[z] ? paces[z].secPerKm : 0);
  const target = (z) => ({ targetType: 'pace', paceLow: Math.round(zonePace(z) * 0.98), paceHigh: Math.round(zonePace(z) * 1.02), zone: z });
  const total = Math.max(20, Math.round(minutes));
  let blocks, label = wantedType;

  if (wantedType === 'Shake Out Run') {
    const raceZone = ROAD_DISTANCE_PROFILES[distKey].racePaceZone;
    const raceLabel = ROAD_DISTANCE_PROFILES[distKey].paceLabel.toLowerCase();
    blocks = [
      { kind: 'simple', id: uid(), label: 'Footing facile', intensity: 'active', durationType: 'time', durationValue: 12, ...target('easy') },
      { kind: 'interval', id: uid(), repeat: 4, work: { label: `Accélération @ ${raceLabel}`, durationType: 'time', durationValue: 1, ...target(raceZone) }, rest: { label: 'Retour facile', durationType: 'time', durationValue: 1, ...target('easy') } },
      { kind: 'simple', id: uid(), label: 'Retour au calme', intensity: 'cooldown', durationType: 'time', durationValue: 4, ...target('easy') },
    ];
    label = `Shake Out Run — 20 min avec accélérations @ ${raceLabel}`;
  } else if (bp.structure === 'progressif') {
    const finish = Math.round(total * bp.finishShare);
    blocks = [
      { kind: 'simple', id: uid(), label: 'Partie facile', intensity: 'active', durationType: 'time', durationValue: total - finish, ...target(bp.zone) },
      { kind: 'simple', id: uid(), label: `Finish à ${racePaceLabel}`, intensity: 'active', durationType: 'time', durationValue: finish, ...target(racePaceZone) },
    ];
    label = `Sortie longue progressive — ${formatDuration(total)} dont ${formatDuration(finish)} @ ${racePaceLabel}`;
  } else if (bp.progression === 'mp') {
    const step = MP_PROGRESSION[Math.min(MP_PROGRESSION.length - 1, progressIdx)];
    blocks = [
      { kind: 'simple', id: uid(), label: 'Échauffement', intensity: 'warmup', durationType: 'time', durationValue: 15, ...target('easy') },
      { kind: 'interval', id: uid(), repeat: step.reps,
        work: { label: `${step.km} km @ ${racePaceLabel}`, durationType: 'distance', durationValue: step.km, ...target(racePaceZone) },
        rest: { label: 'Récupération', durationType: 'time', durationValue: 3, ...target('easy') } },
      { kind: 'simple', id: uid(), label: 'Retour au calme', intensity: 'cooldown', durationType: 'time', durationValue: 10, ...target('easy') },
    ];
    label = `${step.reps} × ${step.km} km @ ${racePaceLabel}`;
  } else if (bp.progression === 'threshold') {
    const step = THRESHOLD_PROGRESSION[Math.min(THRESHOLD_PROGRESSION.length - 1, progressIdx)];
    blocks = [
      { kind: 'simple', id: uid(), label: 'Échauffement', intensity: 'warmup', durationType: 'time', durationValue: 15, ...target('easy') },
      { kind: 'interval', id: uid(), repeat: step.reps,
        work: { label: `${step.minutes} min au seuil`, durationType: 'time', durationValue: step.minutes, ...target('threshold') },
        rest: { label: 'Récupération', durationType: 'time', durationValue: 3, ...target('easy') } },
      { kind: 'simple', id: uid(), label: 'Retour au calme', intensity: 'cooldown', durationType: 'time', durationValue: 10, ...target('easy') },
    ];
    label = `${step.reps} × ${step.minutes} min @ seuil`;
  } else if (bp.structure === 'interval') {
    const warm = 15, cool = 10;
    const body = Math.max(10, total - warm - cool);
    const cycle = bp.workMin + bp.restMin;
    const reps = Math.max(3, Math.min(bp.repeat, Math.floor(body / cycle)));
    blocks = [
      { kind: 'simple', id: uid(), label: 'Échauffement', intensity: 'warmup', durationType: 'time', durationValue: warm, ...target('easy') },
      { kind: 'interval', id: uid(), repeat: reps,
        work: { label: wantedType, durationType: 'time', durationValue: bp.workMin, ...target(bp.zone) },
        rest: { label: 'Récupération', durationType: 'time', durationValue: bp.restMin, ...target('easy') } },
      { kind: 'simple', id: uid(), label: 'Retour au calme', intensity: 'cooldown', durationType: 'time', durationValue: cool, ...target('easy') },
    ];
    label = `${reps} × ${bp.workMin} min — ${wantedType}`;
  } else {
    blocks = [{ kind: 'simple', id: uid(), label: wantedType, intensity: 'active', durationType: 'time', durationValue: total, ...target(bp.zone) }];
  }
  return {
    id: uid(), generated: true, road: true, nom: label, type: wantedType,
    discipline: 'route', paceZone: bp.zone,
    terrain: 'plat', specificite: 'aucune',
    distanceKm: Math.round((km || 0) * 10) / 10, deniveleM: 0, dureeMin: total,
    blocks,
  };
}

function generateSession(wantedType, minutes, km, dplus) {
  const bp = SESSION_BLUEPRINTS[wantedType] || SESSION_BLUEPRINTS['EF'];
  const total = Math.max(15, Math.round(minutes));
  let blocks;
  if (bp.structure === 'interval' && total > 35) {
    // Fit as many reps as the available time allows, keeping warmup/cooldown.
    const warm = Math.min(20, Math.max(10, Math.round(total * 0.2)));
    const cool = Math.min(15, Math.max(8, Math.round(total * 0.12)));
    const body = Math.max(10, total - warm - cool);
    const cycle = bp.workMin + bp.restMin;
    const reps = Math.max(2, Math.min(bp.repeat * 2, Math.floor(body / cycle)));
    blocks = [
      { kind: 'simple', id: uid(), label: 'Échauffement', intensity: 'warmup', durationType: 'time', durationValue: warm, targetType: 'hr', hrLow: 120, hrHigh: 140 },
      { kind: 'interval', id: uid(), repeat: reps,
        work: { label: wantedType, durationType: 'time', durationValue: bp.workMin, targetType: 'hr', hrLow: bp.hrLow, hrHigh: bp.hrHigh },
        rest: { label: 'Récupération', durationType: 'time', durationValue: bp.restMin, targetType: 'open' } },
      { kind: 'simple', id: uid(), label: 'Retour au calme', intensity: 'cooldown', durationType: 'time', durationValue: cool, targetType: 'open' },
    ];
  } else {
    blocks = [{ kind: 'simple', id: uid(), label: wantedType, intensity: 'active', durationType: 'time', durationValue: total, targetType: 'hr', hrLow: bp.hrLow, hrHigh: bp.hrHigh }];
  }
  return {
    id: uid(), generated: true, nom: wantedType, type: wantedType,
    terrain: bp.terrain, specificite: bp.specificite,
    distanceKm: Math.round((km || 0) * 10) / 10, deniveleM: Math.round(dplus || 0), dureeMin: total,
    blocks,
  };
}

// Use a library entry only when it genuinely matches the requested type;
// otherwise the plan builds its own.
function selectTemplateFor(library, wantedType, discipline) {
  // Discipline must match: a marathon threshold session served by "Seuil en
  // côte" is not the same workout at all. Without this filter the road plan
  // silently inherited the trail library.
  const pool = (library || []).filter(t => {
    if (t.type !== wantedType) return false;
    const d = t.discipline || 'trail';
    return discipline ? d === discipline : true;
  });
  return pool.length ? pool[0].id : null;
}

// The week's quality session, chosen by macrocycle rather than by blind
// rotation: Développement builds speed and short hills, Spécifique works the
// race's own demands, Affûtage only sharpens.
function qualityTypeFor(macro, strategy, library, rotIdx) {
  const prefs = (strategy.phaseTypes && strategy.phaseTypes[macro]) || strategy.qualityTypes || [];
  // Deliberately NOT filtered by what the library contains: the plan decides
  // the session it needs and generates it if necessary. Filtering here was the
  // root cause of hill sessions silently becoming EF on an incomplete library.
  const avail = prefs.filter(t => SESSION_BLUEPRINTS[t] && ['EF', 'Récupération', 'Sortie longue', 'Sortie longue spécifique'].indexOf(t) < 0);
  if (!avail.length) return null;
  return avail[rotIdx % avail.length];
}

function buildWeekAssignments(phase, trainingDaysPerWeek, library, rotIdx, weekend, week, objectif) {
  const assign = {}; DAYS.forEach(d => assign[d.key] = []);
  const generated = [];   // sessions the plan created because the library had no match
  if (phase === 'course' && objectif && objectif.date && week) {
    const raceDate = parseISODate(objectif.date);
    const raceDay = raceDate ? Math.round((raceDate - week.monday) / (24 * 3600 * 1000)) : 6;
    const dayKey = (DAYS[Math.max(0, Math.min(6, raceDay))] || DAYS[6]).key;
    assign[dayKey].push({ instanceId: uid(), specialType: 'race', title: objectif.nom || 'COURSE', distanceKm: objectif.distanceKm || 0, deniveleM: objectif.deniveleM || 0, date: objectif.date });
    assign.__meta = { generated, raceDay: true, actualHours: 0, actualKm: 0, actualDPlus: 0 };
    return assign;
  }
  // Attach either a matching library template or a freshly generated session.
  const slotUse = {};  // day -> how many sessions already placed, to pick the slot
  const place = (day, wantedType, hours, km, dplus, extra) => {
    const isRoadPlanHere = objectif && !disciplineStrategy((objectif.effectiveDiscipline) || (objectif.disciplineObjectif) || 'trail').usesChocWeekends;
    // On road the plan ALWAYS generates its own session: the target paces and
    // the week-by-week progression (2x3 km -> 3x5 km) are the whole point, and
    // a static library template carries neither. The library stays a reference
    // catalogue to browse and export, exactly as intended — it never drives.
    const tid = isRoadPlanHere ? null : selectTemplateFor(library, wantedType, 'trail');
    const slots = daySlots(availability, day);
    const idx = slotUse[day] || 0; slotUse[day] = idx + 1;
    const slot = slots.length ? (slots[Math.min(idx, slots.length - 1)]) : 'free';
    const inst = { instanceId: uid(), slot, overrideKm: Math.round((km || 0) * 10) / 10, overrideDPlus: Math.round(dplus || 0), overrideMin: Math.round(hours * 60) };
    if (tid) { inst.templateId = tid; }
    else {
      const gen = (objectif && !disciplineStrategy((objectif.effectiveDiscipline) || (objectif.disciplineObjectif) || 'trail').usesChocWeekends)
        ? generateRoadSession(wantedType, hours * 60, km, objectif.roadPaces, objectif.progressIdx || 0, objectif.distanceKm)
        : generateSession(wantedType, hours * 60, km, dplus);
      generated.push(gen);
      inst.templateId = gen.id;
    }
    if (extra) Object.assign(inst, extra);
    assign[day].push(inst);
  };
  const availability = objectif && objectif.dayAvailability;
  const strategy = disciplineStrategy((objectif && objectif.effectiveDiscipline) || (objectif && objectif.disciplineObjectif) || 'trail');
  const macro = (week && week.macrocycle) || 'developpement';
  const doubles = (objectif && objectif.doubleSession) || { required: false, possible: false };

  const weekHours = week ? week.targetHours : 0;
  const weekKm = week ? week.targetVolumeKm : 0;
  const weekDPlus = week ? week.targetDPlus : 0;
  let shakeOutDay = null;
  if (isRoad && week && week.weeksBeforeRace === 1 && objectif && objectif.date) {
    const rd = parseISODate(objectif.date);
    if (rd) shakeOutDay = (DAYS[Math.max(0, Math.min(6, Math.round((rd - week.monday) / (24 * 3600 * 1000)) - 1))] || {}).key || null;
  }

  // ---- 1. Weekend first (priority on EVERY week, not just choc weeks) -----
  const weekendDays = WEEKEND_KEYS.filter(k => dayCapacityHours(availability, k) > 0);
  const chocDays = (weekend && weekend.days) || 0;
  const chocPool = chocDays === 3 ? ['ven', 'sam', 'dim'] : chocDays === 4 ? ['ven', 'sam', 'dim', 'lun'] : ['sam', 'dim'];
  const isChocWeek = phase === 'choc' || phase === 'picchoc';

  let weekendHours = 0, weekendKm = 0, weekendDPlus = 0;
  const weekendSlots = [];
  if (isChocWeek && weekend) {
    // Choc weeks: the weekend payload is already sized by the periodisation.
    weekendHours = weekend.hours; weekendKm = weekend.km; weekendDPlus = weekend.dplus;
    chocPool.filter(k => dayCapacityHours(availability, k) > 0).forEach((day, idx) => {
      weekendSlots.push({ day, share: (weekend.splits && weekend.splits[idx]) || (1 / chocPool.length), type: 'Sortie longue' });
    });
  } else if (weekendDays.length && weekHours > 0) {
    const pct = weekendTargetPct(phase);
    let wanted = weekHours * pct;
    // Can't exceed what the weekend days can physically hold.
    const weekendCap = weekendDays.reduce((s, k) => s + dayCapacityHours(availability, k), 0);
    wanted = Math.min(wanted, weekendCap);
    weekendHours = wanted;
    weekendKm = weekHours > 0 ? weekKm * (wanted / weekHours) : 0;
    weekendDPlus = weekHours > 0 ? weekDPlus * (wanted / weekHours) : 0;
    // The long run takes the lion's share of the weekend.
    const longDay = weekendDays.indexOf(strategy.longRunDay) >= 0 ? strategy.longRunDay : weekendDays[weekendDays.length - 1];
    weekendDays.forEach(day => {
      const share = weekendDays.length === 1 ? 1 : (day === longDay ? 0.68 : 0.32 / (weekendDays.length - 1));
      weekendSlots.push({ day, share, type: day === shakeOutDay ? 'Shake Out Run' : (day === longDay ? 'Sortie longue' : 'EF'), fixed: day === shakeOutDay });
    });
  }

  // ---- 2. What's left for the weekdays ------------------------------------
  const weekdayKeys = DAYS.map(d => d.key).filter(k => !isWeekendDay(k) && !(isChocWeek && chocPool.indexOf(k) >= 0));
  const available = weekdayKeys.filter(k => dayCapacityHours(availability, k) > 0);

  // Overflow handling. What the weekdays physically cannot hold must go back
  // to the weekend, which usually has room to spare — previously the surplus
  // was simply dropped, so a week with 20h of capacity could report that an
  // 8h target "doesn't fit". The weekend absorbs first, doubling is a last
  // resort, not the first answer.
  let restHours = Math.max(0, weekHours - weekendHours);
  if (!isChocWeek && weekendDays.length && restHours > 0) {
    const weekdayCeiling = available.reduce((s, k) => s + dayCapacityHours(availability, k), 0);
    const overflow = restHours - weekdayCeiling;
    if (overflow > 0.01) {
      const weekendCap = weekendDays.reduce((s, k) => s + dayCapacityHours(availability, k), 0);
      const extra = Math.min(overflow, Math.max(0, weekendCap - weekendHours));
      if (extra > 0) {
        weekendHours += extra;
        weekendKm = weekHours > 0 ? weekKm * (weekendHours / weekHours) : weekendKm;
        weekendDPlus = weekHours > 0 ? weekDPlus * (weekendHours / weekHours) : weekendDPlus;
        restHours = Math.max(0, weekHours - weekendHours);
      }
    }
  }
  const restKm = Math.max(0, weekKm - weekendKm);
  const restDPlus = Math.max(0, weekDPlus - weekendDPlus);

  // Which days we train on is decided FIRST; doubles are then assigned among
  // those days. Doing it the other way round meant the doubled day could be
  // trimmed away by the day-count limit, so the double silently vanished.
  const wantedWeekdaySessions = Math.max(0, (trainingDaysPerWeek || 5) - weekendSlots.length);
  const orderedDays = ['mar', 'jeu', 'mer', 'ven', 'lun'].filter(k => available.indexOf(k) >= 0);
  let keptDays = orderedDays.slice(0, Math.max(1, Math.min(orderedDays.length, wantedWeekdaySessions || orderedDays.length)));
  if (shakeOutDay && !isWeekendDay(shakeOutDay) && dayCapacityHours(availability, shakeOutDay) > 0 && keptDays.indexOf(shakeOutDay) < 0) keptDays = [shakeOutDay, ...keptDays.slice(0, Math.max(0, keptDays.length - 1))];
  // A fixed group session is non-negotiable: make sure its day is kept.
  if (objectif && objectif.fractionneDuJeudi && !disciplineStrategy((objectif.effectiveDiscipline) || (objectif.disciplineObjectif) || 'trail').usesChocWeekends
      && available.indexOf('jeu') >= 0 && keptDays.indexOf('jeu') < 0) {
    keptDays = ['jeu', ...keptDays.slice(0, Math.max(0, keptDays.length - 1))];
  }

  // Doubles are triggered by THIS week's arithmetic, not by a heuristic about
  // how "heavy" it feels: can one session per training day hold what's left?
  const singleCeiling = keptDays.reduce((s, k) => s + Math.min(dayCapacityHours(availability, k), MAX_SESSION_HOURS), 0);
  const weekNeedsDoubles = restHours > singleCeiling + 0.05;
  const capableDays = keptDays.filter(k => daySlotCount(availability, k) >= 2 && dayCapacityHours(availability, k) > MAX_SESSION_HOURS + 0.01);
  const allowDoubles = doubles.possible && capableDays.length > 0 && weekNeedsDoubles;
  // Adaptation doubles during Développement: one light double every other week,
  // so the first real double isn't a shock. Never a way to inflate volume.
  const adaptationDouble = doubles.required && doubles.possible && capableDays.length > 0
    && macro === 'developpement' && !weekNeedsDoubles && (rotIdx % 2 === 0);

  const daySlotsPlan = {};
  keptDays.forEach(k => { daySlotsPlan[k] = 1; });
  if (allowDoubles || adaptationDouble) {
    const deficit = Math.max(0, restHours - singleCeiling);
    const wanted = adaptationDouble ? 1 : Math.max(1, Math.ceil(deficit / MAX_SESSION_HOURS));
    capableDays.slice(0, Math.min(wanted, capableDays.length)).forEach(k => { daySlotsPlan[k] = 2; });
  }

  // ---- 3. Build the weekday session list ----------------------------------
  const isRoad = !strategy.usesChocWeekends;
  const paces = objectif && objectif.roadPaces;
  // On road, the week is organised around its key sessions; a benchmark week
  // REPLACES the key session rather than adding to it.
  const roadKeys = isRoad ? roadWeeklyKeys(macro, rotIdx, (objectif && objectif.distanceKm) || 0) : null;
  const benchmark = isRoad && week ? benchmarkFor(week.weeksBeforeRace, (objectif && objectif.distanceKm) || 0, paces) : null;
  const qType = isRoad ? (roadKeys && roadKeys[0]) : qualityTypeFor(macro, strategy, library, rotIdx);
  const stripQuality = isChocWeek || phase === 'course' || (!isRoad && phase === 'recup');
  const weekdaySlots = [];
  // Optional fixed group session (Thursday midday VMA). When enabled it takes
  // priority over the generated quality session that week.
  // Road-only: a fixed club/group VMA session makes sense in a road build,
  // not in an ultra block where Thursday is an unlocking run.
  const jeudiVMA = objectif && objectif.fractionneDuJeudi && !strategy.usesChocWeekends
    && phase !== 'course' && dayCapacityHours(availability, 'jeu') > 0;
  if (jeudiVMA) weekdaySlots.push({ day: 'jeu', type: 'Fractionné court', second: false, fixed: true, slot: 'midday' });
  keptDays.filter(day => !(jeudiVMA && day === 'jeu')).forEach((day, i) => {
    const n = daySlotsPlan[day] || 1;
    for (let s = 0; s < n; s++) {
      let type;
      if (shakeOutDay && day === shakeOutDay && s === 0) type = 'Shake Out Run';
      else if (s > 0) type = 'EF';                                   // second session stays easy
      else if (!stripQuality && benchmark && i === 0 && !jeudiVMA) type = 'Allure spécifique';  // the test IS the key session
      else if (!stripQuality && qType && i === 0 && !jeudiVMA) type = qType;  // one quality session
      else if (isRoad && !stripQuality && roadKeys && roadKeys[1] && i === 1 && roadKeys[1] !== 'Sortie longue') type = roadKeys[1];
      else if (phase === 'recup' || phase === 'course') type = s === 0 && i === 0 ? 'EF' : 'Récupération';
      else type = i % 2 === 0 ? 'EF' : 'Récupération';
      weekdaySlots.push({ day, type, second: s > 0 });
    }
  });

  // ---- 4. Distribute the remaining volume under the caps ------------------
  const weightOf = (sl) => (SESSION_WEIGHTS[sl.type] || 1) * (sl.second ? 0.55 : 1);
  const totalWeight = weekdaySlots.reduce((s, sl) => s + weightOf(sl), 0) || 1;
  const dayUsed = {};
  let placedHours = 0;

  // First pass by weight, then redistribute what the capped sessions couldn't
  // take to the ones that still have headroom. Without the second pass, an
  // uneven weight split leaves capacity unused while reporting a shortfall.
  const alloc = weekdaySlots.map(sl => ({ sl, hours: 0 }));
  let remaining = restHours;
  for (let pass = 0; pass < 4 && remaining > 0.05; pass++) {
    const open = alloc.filter(a => {
      const dayRoom = dayCapacityHours(availability, a.sl.day) - (dayUsed[a.sl.day] || 0);
      return a.hours < MAX_SESSION_HOURS - 0.01 && dayRoom > 0.01;
    });
    if (!open.length) break;
    const w = open.reduce((s, a) => s + weightOf(a.sl), 0) || 1;
    const before = remaining;
    open.forEach(a => {
      const want = before * (weightOf(a.sl) / w);
      const dayRoom = dayCapacityHours(availability, a.sl.day) - (dayUsed[a.sl.day] || 0);
      const take = Math.max(0, Math.min(want, MAX_SESSION_HOURS - a.hours, dayRoom, remaining));
      if (take <= 0) return;
      a.hours += take;
      dayUsed[a.sl.day] = (dayUsed[a.sl.day] || 0) + take;
      remaining -= take;
    });
    if (before - remaining < 0.01) break; // no progress, stop
  }

  let benchmarkPlaced = false;
  alloc.forEach(({ sl, hours }) => {
    const plannedHours = sl.type === 'Shake Out Run' ? 20 / 60 : hours;
    if (plannedHours <= 0.08) return;
    placedHours += plannedHours;
    const ratio = restHours > 0 ? plannedHours / restHours : 0;
    const isTest = benchmark && !benchmarkPlaced && !sl.second && sl.type === 'Allure spécifique';
    if (isTest) benchmarkPlaced = true;
    place(sl.day, sl.type, plannedHours, restKm * ratio, restDPlus * ratio,
      { ...(isTest ? { benchmark: { ...benchmark } } : {}), ...(sl.slot ? { slot: sl.slot } : {}) });
  });

  // ---- 5. Weekend sessions -------------------------------------------------
  weekendSlots.forEach(sl => {
    const hours = sl.type === 'Shake Out Run' ? 20 / 60 : weekendHours * sl.share;
    if (hours <= 0.08) return;
    placedHours += hours;
    place(sl.day, sl.type, hours, weekendKm * (hours / Math.max(weekendHours, 0.01)), weekendDPlus * (hours / Math.max(weekendHours, 0.01)), { slot: sl.slot });
  });

  // Report what was actually achievable, so the UI can be honest about any gap.
  assign.__meta = {
    targetHours: weekHours,
    actualHours: Math.round(placedHours * 100) / 100,
    weekendHours: Math.round(weekendHours * 100) / 100,
    weekendPct: weekHours > 0 ? Math.round((weekendHours / weekHours) * 100) : 0,
    doubleUsed: weekdaySlots.some(s => s.second),
    benchmark: benchmark || null,
    generated,
    capacityExceeded: weekHours > 0 && (weekHours - placedHours) / weekHours > 0.12 && (weekHours - placedHours) > 1.0,
  };
  return assign;
}


function getApiKey() { try { return window.localStorage.getItem('goat-trail:api-key') || ''; } catch { return ''; } }
function setApiKey(k) { try { k ? window.localStorage.setItem('goat-trail:api-key', k) : window.localStorage.removeItem('goat-trail:api-key'); } catch {} }
class MissingApiKeyError extends Error {
  constructor() { super("Le chat IA nécessite une clé API Anthropic. Ajoute-la dans l'onglet Profil pour l'activer."); this.name='MissingApiKeyError'; }
}
async function callClaude(body) {
  const key = getApiKey();
  if (!key) throw new MissingApiKeyError();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
    body: JSON.stringify(body),
  });
  if (!response.ok) { const t = await response.text().catch(()=> ''); throw new Error(`Erreur API (${response.status}). ${t.slice(0,200)}`); }
  return response.json();
}

// ============================================================================
// Storage helpers (best-effort; app still works in-memory if unavailable)
// ============================================================================
const STORAGE_PREFIX = 'goat-trail:';
async function storageGet(key, fallback) {
  try { const raw = window.localStorage.getItem(STORAGE_PREFIX + key); return raw != null ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
async function storageSet(key, value) {
  try { window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); } catch { /* quota */ }
}

// ============================================================================
// UI bits
// ============================================================================

function DisciplineTag({ session }) {
  const d = session && (session.discipline || (session.tags && session.tags[0]));
  if (!d) return null;
  const isRoute = String(d).toLowerCase().startsWith('route');
  return (
    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ml-1 ${isRoute ? 'bg-sky-950 text-sky-300 border-sky-800' : 'bg-amber-950 text-amber-300 border-amber-800'}`}>
      {isRoute ? 'Route' : 'Trail'}
    </span>
  );
}

function TypeTag({ type }) {
  const easy = CATEGORY_OF_TYPE[type] === 'easy';
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded border ${easy ? 'bg-emerald-950 text-emerald-300 border-emerald-800' : 'bg-orange-950 text-orange-300 border-orange-800'}`}>
      {type}
    </span>
  );
}

function BlockEditor({ block, onChange, onRemove }) {
  if (block.kind === 'simple') {
    return (
      <div className="border border-stone-800 rounded-md p-3 bg-stone-900 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <input className="border border-stone-700 rounded px-2 py-1 text-sm flex-1" value={block.label}
            onChange={e => onChange({ ...block, label: e.target.value })} placeholder="Nom du bloc" />
          <select className="border border-stone-700 rounded px-2 py-1 text-sm" value={block.intensity}
            onChange={e => onChange({ ...block, intensity: e.target.value })}>
            <option value="warmup">Échauffement</option>
            <option value="active">Effort</option>
            <option value="recovery">Récupération</option>
            <option value="cooldown">Retour au calme</option>
          </select>
          <button onClick={onRemove} className="text-stone-600 hover:text-red-400"><Trash2 size={16} /></button>
        </div>
        <div className="flex flex-wrap gap-2 items-center text-sm">
          <select className="border border-stone-700 rounded px-2 py-1" value={block.durationType}
            onChange={e => onChange({ ...block, durationType: e.target.value })}>
            <option value="time">Temps (min)</option>
            <option value="distance">Distance (km)</option>
            <option value="open">Libre</option>
          </select>
          {block.durationType !== 'open' && (
            <input type="number" inputMode="decimal" step="0.1" className="border border-stone-700 rounded px-2 py-1 w-20" value={block.durationValue}
              onChange={e => onChange({ ...block, durationValue: parseFloat(e.target.value) || 0 })} />
          )}
          <select className="border border-stone-700 rounded px-2 py-1" value={block.targetType}
            onChange={e => onChange({ ...block, targetType: e.target.value })}>
            <option value="open">Aucune cible</option>
            <option value="hr">Cible FC</option>
            <option value="pace">Cible allure</option>
          </select>
          {block.targetType === 'hr' && (
            <>
              <input type="number" inputMode="decimal" className="border border-stone-700 rounded px-2 py-1 w-16" value={block.hrLow}
                onChange={e => onChange({ ...block, hrLow: parseInt(e.target.value) || 0 })} placeholder="bas" />
              <span className="text-stone-600">–</span>
              <input type="number" inputMode="decimal" className="border border-stone-700 rounded px-2 py-1 w-16" value={block.hrHigh}
                onChange={e => onChange({ ...block, hrHigh: parseInt(e.target.value) || 0 })} placeholder="haut" />
              <span className="text-stone-600 text-xs">bpm</span>
            </>
          )}
          {block.targetType === 'pace' && (
            <>
              <input className="border border-stone-700 rounded px-2 py-1 w-16" value={block.paceFast}
                onChange={e => onChange({ ...block, paceFast: e.target.value })} placeholder="4:00" />
              <span className="text-stone-600">à</span>
              <input className="border border-stone-700 rounded px-2 py-1 w-16" value={block.paceSlow}
                onChange={e => onChange({ ...block, paceSlow: e.target.value })} placeholder="4:20" />
              <span className="text-stone-600 text-xs">min/km</span>
            </>
          )}
        </div>
      </div>
    );
  }
  // interval
  const upd = (side, patch) => onChange({ ...block, [side]: { ...block[side], ...patch } });
  const SideFields = ({ side, label }) => {
    const f = block[side];
    return (
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <span className="text-xs text-stone-500 w-20">{label}</span>
        <input className="border border-stone-700 rounded px-2 py-1 flex-1 min-w-[100px]" value={f.label}
          onChange={e => upd(side, { label: e.target.value })} />
        <select className="border border-stone-700 rounded px-2 py-1" value={f.durationType}
          onChange={e => upd(side, { durationType: e.target.value })}>
          <option value="time">min</option><option value="distance">km</option><option value="open">libre</option>
        </select>
        {f.durationType !== 'open' && (
          <input type="number" inputMode="decimal" step="0.05" className="border border-stone-700 rounded px-2 py-1 w-16"
            value={f.durationValue} onChange={e => upd(side, { durationValue: parseFloat(e.target.value) || 0 })} />
        )}
        <select className="border border-stone-700 rounded px-2 py-1" value={f.targetType}
          onChange={e => upd(side, { targetType: e.target.value })}>
          <option value="open">aucune</option><option value="hr">FC</option><option value="pace">allure</option>
        </select>
        {f.targetType === 'hr' && (
          <>
            <input type="number" inputMode="decimal" className="border border-stone-700 rounded px-2 py-1 w-14" value={f.hrLow}
              onChange={e => upd(side, { hrLow: parseInt(e.target.value) || 0 })} />
            <input type="number" inputMode="decimal" className="border border-stone-700 rounded px-2 py-1 w-14" value={f.hrHigh}
              onChange={e => upd(side, { hrHigh: parseInt(e.target.value) || 0 })} />
          </>
        )}
        {f.targetType === 'pace' && (
          <>
            <input className="border border-stone-700 rounded px-2 py-1 w-14" value={f.paceFast}
              onChange={e => upd(side, { paceFast: e.target.value })} />
            <input className="border border-stone-700 rounded px-2 py-1 w-14" value={f.paceSlow}
              onChange={e => upd(side, { paceSlow: e.target.value })} />
          </>
        )}
      </div>
    );
  };
  return (
    <div className="border border-stone-800 rounded-md p-3 bg-amber-950/40 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <span>Répéter</span>
          <input type="number" inputMode="decimal" min="1" className="border border-stone-700 rounded px-2 py-1 w-14"
            value={block.repeat} onChange={e => onChange({ ...block, repeat: parseInt(e.target.value) || 1 })} />
          <span>fois</span>
        </div>
        <button onClick={onRemove} className="text-stone-600 hover:text-red-400"><Trash2 size={16} /></button>
      </div>
      <SideFields side="work" label="Effort" />
      <SideFields side="rest" label="Récup." />
    </div>
  );
}

function TemplateEditor({ template, onSave, onCancel }) {
  const [t, setT] = useState(template);
  const updateBlock = (idx, newBlock) => setT({ ...t, blocks: t.blocks.map((b, i) => i === idx ? newBlock : b) });
  const removeBlock = (idx) => setT({ ...t, blocks: t.blocks.filter((_, i) => i !== idx) });
  return (
    <div className="border border-stone-700 rounded-lg p-4 bg-stone-950 space-y-3">
      <div className="flex flex-wrap gap-2">
        <input className="border border-stone-700 rounded px-2 py-1.5 text-sm flex-1 min-w-[160px]" value={t.nom}
          onChange={e => setT({ ...t, nom: e.target.value })} placeholder="Nom de la séance" />
        <select className="border border-stone-700 rounded px-2 py-1.5 text-sm" value={t.type}
          onChange={e => setT({ ...t, type: e.target.value })}>
          {SEANCE_TYPES.map(ty => <option key={ty} value={ty}>{ty}</option>)}
        </select>
        <input type="number" inputMode="decimal" step="0.5" className="border border-stone-700 rounded px-2 py-1.5 text-sm w-24" value={t.distanceKm}
          onChange={e => setT({ ...t, distanceKm: parseFloat(e.target.value) || 0 })} placeholder="km" />
        <input type="number" inputMode="decimal" className="border border-stone-700 rounded px-2 py-1.5 text-sm w-24" value={t.dureeMin}
          onChange={e => setT({ ...t, dureeMin: parseInt(e.target.value) || 0 })} placeholder="min" />
        <input type="number" inputMode="decimal" className="border border-stone-700 rounded px-2 py-1.5 text-sm w-24" value={t.deniveleM || 0}
          onChange={e => setT({ ...t, deniveleM: parseInt(e.target.value) || 0 })} placeholder="D+ m" />
      </div>
      <div className="space-y-2">
        {t.blocks.map((b, i) => (
          <BlockEditor key={b.id} block={b} onChange={(nb) => updateBlock(i, nb)} onRemove={() => removeBlock(i)} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setT({ ...t, blocks: [...t.blocks, emptySimple('Nouveau bloc')] })}
          className="text-sm px-2.5 py-1.5 border border-stone-700 rounded flex items-center gap-1 hover:bg-stone-900"><Plus size={14} /> Bloc simple</button>
        <button onClick={() => setT({ ...t, blocks: [...t.blocks, emptyInterval()] })}
          className="text-sm px-2.5 py-1.5 border border-stone-700 rounded flex items-center gap-1 hover:bg-stone-900"><Plus size={14} /> Répétitions</button>
        <div className="flex-1" />
        <button onClick={onCancel} className="text-sm px-3 py-1.5 rounded text-stone-400 hover:bg-stone-700">Annuler</button>
        <button onClick={() => onSave(t)} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800">Enregistrer</button>
      </div>
    </div>
  );
}

function LibraryTab({ library, setLibrary, focusId, clearFocus }) {
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [discFilter, setDiscFilter] = useState('all');
  // Arriving from a click on a session in the Semaine tab: open it directly.
  useEffect(() => {
    if (focusId && library.some(t => t.id === focusId)) { setEditingId(focusId); setCreating(false); }
  }, [focusId, library]);

  const save = (t) => {
    setLibrary(prev => {
      const exists = prev.some(p => p.id === t.id);
      return exists ? prev.map(p => p.id === t.id ? t : p) : [...prev, t];
    });
    setEditingId(null); setCreating(false);
  };
  const remove = (id) => setLibrary(prev => prev.filter(p => p.id !== id));
  const duplicate = (t) => setLibrary(prev => [...prev, { ...t, id: uid(), nom: t.nom + ' (copie)' }]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-stone-200">Bibliothèque de séances</h2>
        {!creating && (
          <button onClick={() => setCreating(true)} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800 flex items-center gap-1">
            <Plus size={14} /> Nouvelle séance
          </button>
        )}
      </div>
      {creating && (
        <TemplateEditor
          template={{ id: uid(), nom: '', type: 'EF', distanceKm: 10, dureeMin: 60, deniveleM: 0, blocks: [emptySimple('Corps de séance')] }}
          onSave={save} onCancel={() => setCreating(false)} />
      )}
      {/* Trail and road sessions live in the same library; without a filter the
          list is a 22-item jumble where neither discipline is readable. */}
      <div className="flex gap-2 flex-wrap items-center">
        <span className="text-xs text-stone-500">Afficher :</span>
        {[{ v: 'all', l: 'Toutes' }, { v: 'trail', l: 'Trail' }, { v: 'route', l: 'Route' }].map(opt => {
          const n = opt.v === 'all' ? library.length : library.filter(t => t && (t.discipline || 'trail') === opt.v).length;
          return (
            <button key={opt.v} onClick={() => setDiscFilter(opt.v)}
              className={`text-xs px-2.5 py-1 rounded border ${discFilter === opt.v ? 'border-emerald-600 bg-emerald-950 text-emerald-300' : 'border-stone-700 text-stone-400 hover:border-stone-500'}`}>
              {opt.l} <span className="opacity-60">({n})</span>
            </button>
          );
        })}
      </div>
      <div className="grid gap-2">
        {library.filter(t => t && (discFilter === 'all' || (t.discipline || 'trail') === discFilter)).map(t => editingId === t.id ? (
          <TemplateEditor key={t.id} template={t} onSave={save} onCancel={() => setEditingId(null)} />
        ) : (
          <div key={t.id} className="border border-stone-800 rounded-lg p-3 bg-stone-900 flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-stone-200">{t.nom}</span>
                <TypeTag type={t.type} />
                <DisciplineTag session={t} />
              </div>
              <div className="text-xs text-stone-500 mt-0.5">{t.distanceKm} km · {formatDuration(t.dureeMin)} · {t.deniveleM || 0} m D+ · {t.blocks.length} bloc(s)</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => duplicate(t)} title="Dupliquer" className="p-1.5 text-stone-600 hover:text-stone-300"><Copy size={16} /></button>
              <button onClick={() => setEditingId(t.id)} title="Modifier" className="text-sm px-2.5 py-1 rounded border border-stone-700 hover:bg-stone-950">Modifier</button>
              <button onClick={() => remove(t.id)} title="Supprimer" className="p-1.5 text-stone-600 hover:text-red-400"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        {library.length === 0 && <p className="text-sm text-stone-500">Aucune séance dans la bibliothèque pour l'instant.</p>}
      </div>
    </div>
  );
}

function StatChip({ label, value }) {
  return (
    <div className="bg-stone-900 border border-stone-800 rounded-lg px-3 py-2 text-center min-w-[84px]">
      <div className="text-lg font-semibold text-stone-200">{value}</div>
      <div className="text-xs text-stone-500">{label}</div>
    </div>
  );
}

// Descriptive session naming for ultra: the library template name ("EF 1h")
// stops being meaningful once the plan rescales the session, so the displayed
// name is derived from what the session actually IS.
// Convention: <Durée> · <Intensité> · <Profil> [· spécificité]
//   Durée      : Court (<1h) / Moyen (1-2h) / Long (2-4h) / Très long (4h+)
//   Intensité  : Basse / Moyenne / Haute  (from the session type)
//   Profil     : Plat / Vallonné / Montagneux  (from D+ per km)
//   Spécificité: excentrique (descente) / concentrique (montée), when relevant
const TYPE_INTENSITY = {
  'Récupération': 'Basse', 'EF': 'Basse', 'Sortie longue': 'Basse',
  'Sortie longue spécifique': 'Basse', 'Rando-course': 'Basse',
  'Seuil': 'Moyenne', 'Côtes': 'Moyenne', 'Descente / excentrique': 'Moyenne',
  'Montée / concentrique': 'Moyenne',
  'Fractionné long': 'Haute', 'Fractionné court': 'Haute', 'Autre': 'Moyenne',
};
function sessionDurationLabel(min) {
  if (!min) return null;
  if (min < 60) return 'Court';
  if (min < 120) return 'Moyen';
  if (min < 240) return 'Long';
  return 'Très long';
}
function sessionProfileLabel(km, dplus) {
  if (!km || km <= 0) return null;
  const ratio = (dplus || 0) / km; // m of D+ per km
  if (ratio < 15) return 'Plat';
  if (ratio < 50) return 'Vallonné';
  return 'Montagneux';
}
function describeSession(template, eff) {
  if (!template) return '';
  // The title must describe the session that was actually generated, not the
  // library template it came from: "EF 1h" materialised as 1h45 is misleading.
  const TYPE_SHORT = {
    'EF': 'EF', 'Sortie longue': 'Sortie longue', 'Récupération': 'Récupération',
    'Seuil': 'Seuil', 'Côtes': 'Côtes', 'Fractionné court': 'Fractionné court',
    'Fractionné long': 'Fractionné long', 'Rando-course': 'Rando-course',
    'Descente / excentrique': 'Descente / excentrique',
    'Montée / concentrique': 'Montée / concentrique',
    'Sortie longue spécifique': 'Sortie longue spécifique',
  };
  const head = TYPE_SHORT[template.type] || template.type || template.nom;
  const bits = [head];
  if (eff && eff.min) bits.push(formatDuration(eff.min));
  if (eff && eff.km) {
    const kmEq = Math.round(toKmEq(eff.km, eff.dplus));
    if (kmEq > 0) bits.push(`${kmEq} km-éq`);
  }
  return bits.join(' — ');
}
// Secondary line: the qualitative character of the session.
function sessionQualifiers(template, eff) {
  const parts = [];
  const intensity = TYPE_INTENSITY[template.type] || 'Moyenne';
  parts.push(`intensité ${intensity.toLowerCase()}`);
  const TERRAIN_LABELS = { plat: 'plat', vallonne: 'vallonné', montee: 'montée', descente: 'descente', montagne: 'montagne', technique: 'technique' };
  const terrain = template.terrain ? TERRAIN_LABELS[template.terrain] : (sessionProfileLabel(eff.km, eff.dplus) || '').toLowerCase();
  if (terrain) parts.push(terrain);
  if (template.specificite && ['aucune', 'mixte'].indexOf(template.specificite) < 0) parts.push(template.specificite);
  const reps = (template.blocks || []).find(b => b.kind === 'interval');
  if (reps && reps.repeat > 1) parts.push(`${reps.repeat} séries`);
  return parts.join(' · ');
}

function PlanningTab({ library, monday, setMonday, weekPlan, setWeekPlan, meta, onOpenSession, benchmarkResults, onBenchmarkResult }) {
  const [addingDay, setAddingDay] = useState(null);
  const [pickTemplateId, setPickTemplateId] = useState(library[0]?.id || '');

  const templateById = (id) => library.find(t => t.id === id);
  const effective = (inst, t) => ({
    km: inst.overrideKm ?? t.distanceKm,
    min: inst.overrideMin ?? t.dureeMin,
    dplus: inst.overrideDPlus ?? (t.deniveleM || 0),
  });

  const addToDay = (dayKey) => {
    if (!pickTemplateId) return;
    setWeekPlan(prev => ({ ...prev, [dayKey]: [...(prev[dayKey] || []), { instanceId: uid(), templateId: pickTemplateId }] }));
    setAddingDay(null);
  };
  const removeFromDay = (dayKey, instanceId) => {
    setWeekPlan(prev => ({ ...prev, [dayKey]: prev[dayKey].filter(i => i.instanceId !== instanceId) }));
  };

  let totalKm = 0, totalMin = 0, totalDPlus = 0, nbSorties = 0, nbEF = 0, nbIntense = 0;
  DAYS.forEach(d => (weekPlan[d.key] || []).forEach(inst => {
    const t = templateById(inst.templateId);
    if (!t) return;
    const e = effective(inst, t);
    totalKm += e.km; totalMin += e.min; totalDPlus += e.dplus; nbSorties += 1;
    if (CATEGORY_OF_TYPE[t.type] === 'easy') nbEF += 1; else nbIntense += 1;
  }));

  const exportInstance = (inst) => {
    const t = templateById(inst.templateId);
    if (!t) return;
    let blocks = t.blocks;
    // Scale the whole session to the planned duration. Previously only a
    // single simple time-block was handled, so interval sessions (Fractionné,
    // Côtes, Seuil) exported at their original library length and ignored the
    // plan entirely. Now every time-based part is scaled by the same factor,
    // preserving the session's structure while matching the planned volume.
    const baseMin = t.dureeMin || 0;
    if (inst.overrideMin && baseMin > 0) {
      const f = inst.overrideMin / baseMin;
      const scaleField = (b) => (b && b.durationType === 'time')
        ? { ...b, durationValue: Math.max(1, Math.round((b.durationValue || 0) * f * 10) / 10) }
        : (b && b.durationType === 'distance')
          ? { ...b, durationValue: Math.max(0.05, Math.round((b.durationValue || 0) * f * 100) / 100) }
          : b;
      blocks = (blocks || []).map(b => {
        if (b.kind === 'simple') return scaleField(b);
        if (b.kind === 'interval') return { ...b, work: scaleField(b.work), rest: scaleField(b.rest) };
        return b;
      });
    }
    const steps = flattenBlocks(blocks);
    const name = describeSession(t, effective(inst, t)) || t.nom;
    const bytes = buildWorkoutFit(name, steps.length ? steps : [{ name: t.nom, intensity: 'active', duration: { type: 'open' }, target: { type: 'open' } }]);
    downloadFit(name, bytes);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setMonday(addDays(monday, -7))} className="p-1.5 border border-stone-700 rounded hover:bg-stone-950"><ChevronLeft size={16} /></button>
          <span className="text-sm font-medium text-stone-300">Semaine du {fmtShort(monday)} au {fmtShort(addDays(monday, 6))}</span>
          <button onClick={() => setMonday(addDays(monday, 7))} className="p-1.5 border border-stone-700 rounded hover:bg-stone-950"><ChevronRight size={16} /></button>
          {meta && meta.macrocycle && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border" style={{ color: MACROCYCLES[meta.macrocycle].color, borderColor: MACROCYCLES[meta.macrocycle].color + '66' }}>
              {MACROCYCLES[meta.macrocycle].label}
            </span>
          )}
          {meta && <PhaseTag phase={meta.phase} />}
          {meta && meta.doubleUsed && <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-800 text-stone-300 border border-stone-700">biquotidien</span>}
          {meta && meta.atPeak && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-200 border border-emerald-700">volume max</span>}
          {meta && meta.weeksBeforeRace != null && <span className="text-xs text-stone-500">{meta.weeksBeforeRace === 0 ? 'jour J' : `J-${meta.weeksBeforeRace} sem.`}</span>}
        </div>
        <div className="flex gap-2 flex-wrap">
          <StatChip label="Volume" value={`${totalKm.toFixed(0)} km`} />
          <StatChip label="Temps" value={`${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, '0')}`} />
          <StatChip label="D+" value={`${totalDPlus} m`} />
          <StatChip label="Sorties" value={nbSorties} />
          <StatChip label="EF" value={nbEF} />
          <StatChip label="Intense" value={nbIntense} />
        </div>
      </div>
      {meta && meta.note && <div className="text-[11px] text-stone-500 -mt-2">{meta.note}</div>}
      {meta && meta.benchmark && (() => {
        const wk = weekKey(monday);
        const result = (benchmarkResults || {})[wk];
        const fails = Object.keys(benchmarkResults || {}).filter(k => benchmarkResults[k] === 'echoue').length;
        const advice = result ? benchmarkAdvice(result, fails) : null;
        return (
          <div className="rounded-lg border p-4" style={{ borderColor: '#EF9F2766', backgroundColor: '#3a2a08' }}>
            <div className="flex items-center gap-2 mb-1">
              <Target size={15} className="text-amber-300" />
              <span className="text-sm font-medium text-amber-200">{meta.benchmark.label}</span>
              <span className="text-xs text-amber-300/70">J-{meta.benchmark.weeksBefore * 7} environ</span>
            </div>
            <div className="text-sm text-stone-200">{meta.benchmark.description}{meta.benchmark.targetPace ? ` @ ${fmtPace(meta.benchmark.targetPace)}` : ''}</div>
            <div className="text-[11px] text-stone-400 mt-1">
              Cette séance remplace la séance clé de la semaine — c'est un indice sur ta forme, pas un verdict :
              l'endurance, la nutrition et la gestion d'allure du jour J ne se testent pas ici.
            </div>
            <div className="flex gap-2 mt-3 flex-wrap">
              {[{ v: 'reussi', l: '✅ Réussi' }, { v: 'partiel', l: '🟡 Réussi difficilement' }, { v: 'echoue', l: '🔴 Manqué' }].map(opt => (
                <button key={opt.v} onClick={() => onBenchmarkResult && onBenchmarkResult(wk, opt.v)}
                  className={`text-xs px-3 py-1.5 rounded border ${result === opt.v ? 'border-amber-500 bg-amber-950 text-amber-200' : 'border-stone-700 text-stone-300 hover:border-stone-500'}`}>
                  {opt.l}
                </button>
              ))}
            </div>
            {advice && (
              <div className={`text-xs mt-3 rounded px-3 py-2 ${advice.tone === 'alert' ? 'bg-red-950 border border-red-800 text-red-200' : advice.tone === 'warn' ? 'bg-amber-950 border border-amber-800 text-amber-200' : 'bg-emerald-950 border border-emerald-800 text-emerald-200'}`}>
                {advice.text}
                {advice.options && (
                  <ul className="mt-1.5 list-disc list-inside opacity-90">
                    {advice.options.map((o, i) => <li key={i}>{o}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })()}
      {meta && meta.capacityExceeded && (
        <div className="text-[11px] text-amber-300 bg-amber-950 border border-amber-800 rounded px-3 py-2 -mt-1">
          Volume cible {formatDuration((meta.targetHours || 0) * 60)} · réellement plaçable {formatDuration((meta.actualHours || 0) * 60)}.
          Tes disponibilités ne permettent pas d'absorber la cible sans dépasser les plafonds ({MAX_SESSION_HOURS}h/séance, {MAX_DAILY_HOURS}h/jour en semaine) — le plan génère le maximum cohérent plutôt que de forcer.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        {DAYS.map((d, idx) => (
          <div key={d.key} className="border border-stone-800 rounded-lg bg-stone-900 flex flex-col min-h-[140px]">
            <div className="px-3 py-2 border-b border-stone-900">
              <div className="text-sm font-medium text-stone-200">{d.label}</div>
              <div className="text-xs text-stone-600">{fmtShort(addDays(monday, idx))}</div>
            </div>
            {/* Three fixed sections per day — morning / midday / evening —
                mirroring the availability the user declared. Empty slots stay
                visible so a double session reads instantly. */}
            <div className="flex-1 p-2 space-y-2">
              {['morning', 'midday', 'evening'].map(slotKey => {
                const list = (weekPlan[d.key] || []).filter(i => (i.slot === slotKey) || (slotKey === 'evening' && (!i.slot || i.slot === 'free')));
                return (
                  <div key={slotKey}>
                    <div className="text-[10px] uppercase tracking-wide text-stone-600 mb-1">{SLOT_LABELS[slotKey]}</div>
                    {list.length === 0 ? (
                      <div className="border border-dashed border-stone-800 rounded-md h-7" />
                    ) : list.map(inst => {
                      if (inst.specialType === 'race') return (
                        <div key={inst.instanceId} className="border-2 border-amber-600 rounded-md p-3 mb-1.5 bg-amber-950/40">
                          <div className="text-[10px] uppercase tracking-wide text-amber-400 font-semibold">COURSE</div>
                          <div className="text-base font-semibold text-amber-100 mt-0.5">{inst.title}</div>
                          <div className="text-sm text-stone-300 mt-1">{inst.distanceKm} km · {inst.deniveleM || 0} m D+ · Jour J</div>
                          <button onClick={() => removeFromDay(d.key, inst.instanceId)} className="mt-2 text-xs text-stone-500 hover:text-red-400">Retirer</button>
                        </div>
                      );
                      const t = templateById(inst.templateId);
                      if (!t) return null;
                      const e = effective(inst, t);
                      return (
                        <div key={inst.instanceId} className={`border rounded-md p-2 mb-1.5 ${inst.benchmark ? 'border-amber-700 bg-amber-950/40' : ROAD_KEY_TYPES.indexOf(t.type) >= 0 && t.type !== 'EF' ? 'border-emerald-800 bg-emerald-950/30' : 'border-stone-800 bg-stone-950'}`}>
                          <div className="flex items-start justify-between gap-1">
                            <button onClick={() => onOpenSession && onOpenSession(t.id)} className="text-left flex-1 min-w-0 group">
                              <span className="text-sm text-stone-200 leading-tight group-hover:text-emerald-300 block truncate">{describeSession(t, e)}</span>
                              <span className="text-[11px] text-stone-500 block truncate">{sessionQualifiers(t, e)}</span>
                            </button>
                            <button onClick={() => removeFromDay(d.key, inst.instanceId)} className="text-stone-600 hover:text-red-400 shrink-0"><X size={14} /></button>
                          </div>
                          <div className="flex items-center flex-wrap gap-y-1 mt-1">
                            {inst.benchmark && <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-900 text-amber-200 border border-amber-700 mr-1">TEST</span>}
                            <TypeTag type={t.type} /><DisciplineTag session={t} />
                            {t.generated && <span className="inline-block text-[10px] px-1.5 py-0.5 rounded border ml-1 bg-stone-800 text-stone-400 border-stone-700">générée</span>}
                          </div>
                          <div className="text-xs text-stone-500 mt-1">{e.km} km · {formatDuration(e.min)} · {e.dplus} m D+</div>
                          <button onClick={() => exportInstance(inst)} className="mt-1.5 text-xs flex items-center gap-1 text-emerald-400 hover:text-emerald-200">
                            <Download size={12} /> Exporter .fit
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="p-2 border-t border-stone-900">
              {addingDay === d.key ? (
                <div className="flex gap-1">
                  <select className="border border-stone-700 rounded px-1.5 py-1 text-xs flex-1" value={pickTemplateId}
                    onChange={e => setPickTemplateId(e.target.value)}>
                    {library.map(t => <option key={t.id} value={t.id}>{t.nom}</option>)}
                  </select>
                  <button onClick={() => addToDay(d.key)} className="text-xs px-2 py-1 bg-emerald-700 text-white rounded">Ok</button>
                </div>
              ) : (
                <button onClick={() => setAddingDay(d.key)} className="text-xs text-stone-500 hover:text-stone-200 flex items-center gap-1">
                  <Plus size={12} /> Ajouter
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AssistantTab({ library, monday, weekPlan, setWeekPlan }) {
  const [messages, setMessages] = useState([]); // {role, content, plan?}
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => { scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }); }, [messages, loading]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: 'user', content: input.trim() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    const libSummary = library.map(t => ({ id: t.id, nom: t.nom, type: t.type, distanceKm: t.distanceKm, dureeMin: t.dureeMin }));
    const systemPrompt = `Tu es un coach qui aide à répartir des séances de trail running sur une semaine.
Bibliothèque de séances disponibles (utilise UNIQUEMENT ces id exacts) : ${JSON.stringify(libSummary)}
Semaine ciblée : du ${fmtShort(monday)} au ${fmtShort(addDays(monday, 6))}.
Réponds en français, en 2 à 4 phrases concises expliquant ta logique, puis termine TOUJOURS par un bloc de code JSON au format exact (jours: lun,mar,mer,jeu,ven,sam,dim) :
\`\`\`json
{"plan": {"lun": ["id"], "mar": [], "mer": ["id"], "jeu": [], "ven": ["id"], "sam": ["id"], "dim": []}}
\`\`\`
Un tableau vide = jour de repos. N'invente jamais d'id absent de la bibliothèque.`;

    try {
      const data = await callClaude({
          model: 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: systemPrompt,
          messages: nextMessages.map(m => ({ role: m.role, content: m.content })),
        });
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      let plan = null;
      const m = /```json\s*([\s\S]*?)```/.exec(text);
      if (m) { try { plan = JSON.parse(m[1]).plan; } catch { /* ignore */ } }
      const clean = text.replace(/```json[\s\S]*?```/, '').trim();
      setMessages(prev => [...prev, { role: 'assistant', content: clean || text, plan }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: "Erreur de connexion à l'assistant. Réessaie dans un instant." }]);
    } finally {
      setLoading(false);
    }
  };

  const applyPlan = (plan) => {
    setWeekPlan(prev => {
      const next = { ...prev };
      Object.entries(plan).forEach(([day, ids]) => {
        if (DAYS.some(d => d.key === day) && Array.isArray(ids)) {
          next[day] = ids.filter(id => library.some(t => t.id === id)).map(id => ({ instanceId: uid(), templateId: id }));
        }
      });
      return next;
    });
  };

  return (
    <div className="flex flex-col h-[70vh] max-h-[640px] border border-stone-800 rounded-lg bg-stone-900">
      <div className="px-4 py-2.5 border-b border-stone-900 text-sm text-stone-400">
        Semaine ciblée : du {fmtShort(monday)} au {fmtShort(addDays(monday, 6))}. Décris tes contraintes (jours dispos, fatigue, objectif) et l'assistant propose une répartition.
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <p className="text-sm text-stone-600">Ex. : "Je peux courir lundi soir, mercredi midi, samedi et dimanche matin. Jambes un peu fatiguées, objectif Serre-Ponçon dans 3 semaines."</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'bg-emerald-700 text-white' : 'bg-stone-800 text-stone-200'}`}>
              <div className="whitespace-pre-wrap">{m.content}</div>
              {m.plan && (
                <button onClick={() => applyPlan(m.plan)} className="mt-2 text-xs px-2.5 py-1 rounded bg-stone-900 text-emerald-300 border border-emerald-700 hover:bg-emerald-950">
                  Appliquer ce planning à la semaine
                </button>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-stone-800 rounded-lg px-3 py-2 text-sm text-stone-500 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> L'assistant réfléchit…
            </div>
          </div>
        )}
      </div>
      <div className="p-3 border-t border-stone-900 flex gap-2">
        <textarea
          className="flex-1 border border-stone-700 rounded-md px-3 py-2 text-sm resize-none"
          rows={2} value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Décris ta semaine..." />
        <button onClick={send} disabled={loading} className="px-3 py-2 rounded-md bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50 self-end">
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

const ZONE_LABELS = [
  { key: 'recup', label: 'Récupération' }, { key: 'ef', label: 'EF' }, { key: 'sortieLongue', label: 'Sortie longue' },
  { key: 'seuil', label: 'Seuil' }, { key: 'fracLong', label: 'Fractionné long' }, { key: 'fracCourt', label: 'Fractionné court / VMA' },
  { key: 'cotes', label: 'Côtes (effort)' },
];

function fieldReq(discipline, field) { return disciplineConfig(discipline)[field]; }

function emptyHistoryEntry() {
  return { id: uid(), date: '', nom: '', discipline: 'trail', contexte: 'course', tempsStr: '', distanceKm: '', deniveleM: '', terrain: '', effort: '', notes: '' };
}

function HistoryEntryEditor({ entry, onSave, onCancel }) {
  const [e, setE] = useState(entry);
  const cfg = disciplineConfig(e.discipline);
  const effortOptions = EFFORT_OPTIONS[e.contexte] || EFFORT_OPTIONS.course;

  const missing = [];
  if (!e.date) missing.push('date');
  if (!e.nom) missing.push('nom');
  if (!e.tempsStr || !parseTimeToSeconds(e.tempsStr)) missing.push('temps');
  if (!e.effort) missing.push('effort ressenti');
  if (cfg.distance === 'required' && !e.distanceKm) missing.push('distance');
  if (cfg.dplus === 'required' && !e.deniveleM) missing.push('D+');

  const save = () => {
    if (missing.length) return;
    onSave({ ...e, distanceKm: parseFloat(e.distanceKm) || 0, deniveleM: parseFloat(e.deniveleM) || 0, tempsSec: parseTimeToSeconds(e.tempsStr) });
  };

  return (
    <div className="border border-stone-700 rounded-lg p-3 bg-stone-950 space-y-2">
      <div className="flex flex-wrap gap-2">
        <Field label="Date"><input type="date" className={inputCls} value={e.date} onChange={ev => setE({ ...e, date: ev.target.value })} /></Field>
        <div className="flex-1 min-w-[140px]"><Field label="Nom"><input className={`${inputCls} w-full`} value={e.nom} onChange={ev => setE({ ...e, nom: ev.target.value })} /></Field></div>
        <Field label="Discipline">
          <select className={inputCls} value={e.discipline} onChange={ev => setE({ ...e, discipline: ev.target.value, terrain: '' })}>
            {DISCIPLINES.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </Field>
        <Field label="Contexte">
          <select className={inputCls} value={e.contexte} onChange={ev => setE({ ...e, contexte: ev.target.value, effort: '' })}>
            <option value="course">Course</option>
            <option value="entrainement">Entraînement</option>
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-2 items-end">
        <Field label="Temps (h:mm:ss ou mm:ss)"><input className={`${inputCls} w-32`} value={e.tempsStr} onChange={ev => setE({ ...e, tempsStr: ev.target.value })} placeholder="3:30:00" /></Field>
        {cfg.distance !== 'hidden' && (
          <Field label={`Distance (km)${cfg.distance === 'optional' ? ' — optionnel' : ''}`}>
            <input type="number" inputMode="decimal" className={`${inputCls} w-24`} value={e.distanceKm} onChange={ev => setE({ ...e, distanceKm: ev.target.value })} /></Field>
        )}
        {cfg.dplus !== 'hidden' && (
          <Field label={`D+ (m)${cfg.dplus === 'optional' ? ' — optionnel' : ''}`}>
            <input type="number" inputMode="decimal" className={`${inputCls} w-24`} value={e.deniveleM} onChange={ev => setE({ ...e, deniveleM: ev.target.value })} /></Field>
        )}
        {cfg.terrain !== 'hidden' && (
          <Field label="Terrain (optionnel)">
            <select className={inputCls} value={e.terrain} onChange={ev => setE({ ...e, terrain: ev.target.value })}>
              <option value="">—</option>
              {TERRAIN_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        )}
        <Field label="Effort ressenti">
          <select className={inputCls} value={e.effort} onChange={ev => setE({ ...e, effort: ev.target.value })}>
            <option value="">—</option>
            {effortOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Notes (optionnel)"><textarea className={`${inputCls} w-full`} rows={2} value={e.notes} onChange={ev => setE({ ...e, notes: ev.target.value })} /></Field>
      <div className="flex items-center gap-2 pt-1">
        <button onClick={save} disabled={missing.length > 0} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed">Enregistrer</button>
        <button onClick={onCancel} className="text-sm px-3 py-1.5 rounded text-stone-400 hover:bg-stone-700">Annuler</button>
        {missing.length > 0 && <span className="text-xs text-stone-600">Manque : {missing.join(', ')}</span>}
      </div>
    </div>
  );
}

function HistoryRow({ entry, onEdit, onDelete }) {
  const cfg = disciplineConfig(entry.discipline);
  const mm = Math.floor((entry.tempsSec || 0) / 60);
  const timeLabel = entry.tempsSec >= 3600 ? `${Math.floor(entry.tempsSec / 3600)}h${String(mm % 60).padStart(2, '0')}` : `${mm} min`;
  return (
    <div className="border border-stone-800 rounded-md p-2.5 bg-stone-900 flex items-center justify-between gap-2">
      <div>
        <div className="text-sm text-stone-200">
          <span className="font-medium">{entry.nom}</span>
          <span className="text-stone-600"> · {entry.date}</span>
        </div>
        <div className="text-xs text-stone-500 mt-0.5">
          {cfg.label} · {entry.contexte === 'course' ? 'course' : 'entraînement'} · {timeLabel}
          {entry.distanceKm ? ` · ${entry.distanceKm} km` : ''}{entry.deniveleM ? ` · ${entry.deniveleM} m D+` : ''}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button onClick={onEdit} className="text-sm px-2.5 py-1 rounded border border-stone-700 hover:bg-stone-950">Modifier</button>
        <button onClick={onDelete} className="p-1.5 text-stone-600 hover:text-red-400"><Trash2 size={16} /></button>
      </div>
    </div>
  );
}

// AI quiz: parses free-text endurance history into structured entries, and —
// unlike a one-shot parser — asks back for any field the discipline requires
// but the text didn't mention, before the entry is considered ready to add.
function HistoryQuizChat({ onAddEntries, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState([]);
  const scrollRef = useRef(null);

  useEffect(() => { scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }); }, [messages, loading]);

  const disciplineRules = DISCIPLINES.map(d => `- ${d.key} (${d.label}) : distance ${d.distance}, D+ ${d.dplus}, terrain ${d.terrain}`).join('\n');

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: 'user', content: input.trim() };
    const next = [...messages, userMsg];
    setMessages(next); setInput(''); setLoading(true);

    const systemPrompt = `Tu aides à construire l'historique sportif d'un coureur pour calibrer un plan d'entraînement trail. Extrais les performances mentionnées (courses ou séances d'entraînement notables, tous sports d'endurance).
Champs par entrée : date (ISO si possible, sinon approximatif), nom, discipline (une valeur parmi: ${DISCIPLINES.map(d => d.key).join(', ')}), contexte ("course" ou "entrainement"), tempsStr (ex "3:30:00" ou "42:30"), distanceKm, deniveleM, terrain, effort, notes.
Règles de champs obligatoires par discipline :
${disciplineRules}
Le temps est TOUJOURS obligatoire, quelle que soit la discipline.
Si une entrée mentionnée par l'utilisateur n'a pas un champ obligatoire pour sa discipline, NE L'INVENTE JAMAIS : pose une question ciblée dans ta réponse en texte pour combler ce manque précis avant de la considérer complète.
Réponds en français, brièvement, puis termine TOUJOURS ta réponse par un bloc JSON avec la liste COMPLÈTE et à jour de toutes les entrées discutées jusqu'ici (même incomplètes) :
\`\`\`json
{"entries": [{"date":"","nom":"","discipline":"","contexte":"","tempsStr":"","distanceKm":null,"deniveleM":null,"terrain":"","effort":"","notes":"","missing":["distance"]}]}
\`\`\`
Le champ "missing" liste les champs obligatoires encore manquants pour cette entrée (tableau vide si complète).`;

    try {
      const data = await callClaude({ model: 'claude-sonnet-4-6', max_tokens: 1500, system: systemPrompt, messages: next.map(m => ({ role: m.role, content: m.content })) });
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const m = /```json\s*([\s\S]*?)```/.exec(text);
      if (m) { try { setDraft(JSON.parse(m[1]).entries || []); } catch { /* ignore */ } }
      const clean = text.replace(/```json[\s\S]*?```/, '').trim();
      setMessages(prev => [...prev, { role: 'assistant', content: clean || text }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: err instanceof MissingApiKeyError ? err.message : `Erreur : ${err.message || 'connexion impossible'}. Réessaie.` }]);
    } finally { setLoading(false); }
  };

  const updateDraft = (idx, patch) => setDraft(prev => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));
  const removeDraft = (idx) => setDraft(prev => prev.filter((_, i) => i !== idx));

  const commit = () => {
    const ready = draft.filter(d => (!d.missing || d.missing.length === 0) && d.tempsStr && parseTimeToSeconds(d.tempsStr));
    const entries = ready.map(d => ({
      id: uid(), date: d.date || '', nom: d.nom || '', discipline: DISCIPLINES.some(x => x.key === d.discipline) ? d.discipline : 'autre',
      contexte: d.contexte === 'entrainement' ? 'entrainement' : 'course', tempsStr: d.tempsStr, tempsSec: parseTimeToSeconds(d.tempsStr),
      distanceKm: parseFloat(d.distanceKm) || 0, deniveleM: parseFloat(d.deniveleM) || 0, terrain: d.terrain || '', effort: d.effort || '', notes: d.notes || '',
    }));
    if (entries.length) onAddEntries(entries);
    onClose();
  };

  return (
    <div className="border border-stone-700 rounded-lg bg-stone-900 overflow-hidden">
      <div className="flex flex-col h-[50vh] max-h-[420px]">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
          {messages.length === 0 && <p className="text-sm text-stone-600">Décris tes performances marquantes en une fois : "Marathon en 3h30 il y a 2 mois, un 75 km trail en mai avec 4000m D+ en 11h, l'Embrunman il y a 3 ans..."</p>}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'bg-emerald-700 text-white' : 'bg-stone-800 text-stone-200'}`}>{m.content}</div>
            </div>
          ))}
          {loading && <div className="text-sm text-stone-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Réflexion…</div>}
        </div>
        <div className="p-2.5 border-t border-stone-900 flex gap-2">
          <textarea className="flex-1 border border-stone-700 rounded-md px-2.5 py-1.5 text-sm resize-none" rows={2} value={input}
            onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button onClick={send} disabled={loading} className="px-3 py-1.5 rounded-md bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50 self-end"><Send size={16} /></button>
        </div>
      </div>
      {draft.length > 0 && (
        <div className="border-t border-stone-800 p-3 space-y-2 bg-stone-950">
          <div className="text-xs text-stone-500">Relis avant d'ajouter — corrige ce qui est mal interprété :</div>
          {draft.map((d, i) => {
            const cfg = disciplineConfig(d.discipline);
            const isMissing = d.missing && d.missing.length > 0;
            return (
              <div key={i} className={`border rounded-md p-2 text-sm space-y-1.5 ${isMissing ? 'border-amber-700 bg-amber-950' : 'border-stone-800 bg-stone-900'}`}>
                <div className="flex flex-wrap gap-1.5 items-center">
                  <input className="border border-stone-700 rounded px-1.5 py-1 text-xs flex-1 min-w-[100px]" value={d.nom || ''} onChange={e => updateDraft(i, { nom: e.target.value })} placeholder="nom" />
                  <input type="date" className="border border-stone-700 rounded px-1.5 py-1 text-xs" value={d.date || ''} onChange={e => updateDraft(i, { date: e.target.value })} />
                  <select className="border border-stone-700 rounded px-1.5 py-1 text-xs" value={d.discipline || 'autre'} onChange={e => updateDraft(i, { discipline: e.target.value })}>
                    {DISCIPLINES.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                  <select className="border border-stone-700 rounded px-1.5 py-1 text-xs" value={d.contexte || 'course'} onChange={e => updateDraft(i, { contexte: e.target.value })}>
                    <option value="course">course</option><option value="entrainement">entraînement</option>
                  </select>
                </div>
                <div className="flex flex-wrap gap-1.5 items-center">
                  <input className="border border-stone-700 rounded px-1.5 py-1 text-xs w-20" value={d.tempsStr || ''} onChange={e => updateDraft(i, { tempsStr: e.target.value })} placeholder="temps" />
                  {cfg.distance !== 'hidden' && <input type="number" inputMode="decimal" className="border border-stone-700 rounded px-1.5 py-1 text-xs w-16" value={d.distanceKm ?? ''} onChange={e => updateDraft(i, { distanceKm: e.target.value })} placeholder="km" />}
                  {cfg.dplus !== 'hidden' && <input type="number" inputMode="decimal" className="border border-stone-700 rounded px-1.5 py-1 text-xs w-16" value={d.deniveleM ?? ''} onChange={e => updateDraft(i, { deniveleM: e.target.value })} placeholder="D+" />}
                  <button onClick={() => removeDraft(i)} className="text-stone-600 hover:text-red-400 ml-auto"><X size={14} /></button>
                </div>
                {isMissing && <div className="text-[11px] text-amber-300">Manque encore : {d.missing.join(', ')} — complète ci-dessus ou dis-le dans le chat.</div>}
              </div>
            );
          })}
          <div className="flex gap-2 pt-1">
            <button onClick={commit} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800">Ajouter à l'historique</button>
            <button onClick={onClose} className="text-sm px-3 py-1.5 rounded text-stone-400 hover:bg-stone-800">Fermer sans ajouter</button>
          </div>
        </div>
      )}
    </div>
  );
}

function HistorySection({ history, setHistory }) {
  const [editingId, setEditingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [quizOpen, setQuizOpen] = useState(false);
  const list = history || [];

  const save = (entry) => {
    setHistory(prev => {
      const arr = prev || [];
      return arr.some(e => e.id === entry.id) ? arr.map(e => e.id === entry.id ? entry : e) : [...arr, entry];
    });
    setEditingId(null); setCreating(false);
  };
  const remove = (id) => setHistory(prev => (prev || []).filter(e => e.id !== id));
  const addFromQuiz = (entries) => setHistory(prev => [...(prev || []), ...entries]);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-medium text-stone-200">Historique sportif</h2>
        <p className="text-sm text-stone-500 mt-1">Tes performances passées (courses ou sorties notables, tous sports d'endurance) calibrent le temps de course estimé et la vitesse de montée en charge de l'onglet Objectif.</p>
      </div>
      <div className="flex gap-2">
        {!creating && <button onClick={() => { setCreating(true); setQuizOpen(false); }} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800 flex items-center gap-1"><Plus size={14} /> Ajouter manuellement</button>}
        {!quizOpen && <button onClick={() => { setQuizOpen(true); setCreating(false); setEditingId(null); }} className="text-sm px-3 py-1.5 rounded border border-stone-700 hover:bg-stone-950">Remplir via chat</button>}
      </div>
      {creating && <HistoryEntryEditor entry={emptyHistoryEntry()} onSave={save} onCancel={() => setCreating(false)} />}
      {quizOpen && <HistoryQuizChat onAddEntries={addFromQuiz} onClose={() => setQuizOpen(false)} />}
      <div className="space-y-2">
        {list.map(entry => editingId === entry.id
          ? <HistoryEntryEditor key={entry.id} entry={{ ...entry, tempsStr: entry.tempsStr || '' }} onSave={save} onCancel={() => setEditingId(null)} />
          : <HistoryRow key={entry.id} entry={entry} onEdit={() => setEditingId(entry.id)} onDelete={() => remove(entry.id)} />
        )}
        {list.length === 0 && !creating && <p className="text-sm text-stone-600">Aucune performance enregistrée pour l'instant.</p>}
      </div>
    </div>
  );
}

function ApiKeyPanel() {
  const [key, setKey] = useState(() => getApiKey());
  const [saved, setSaved] = useState(false);
  const save = () => { setApiKey(key.trim()); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  return (
    <div className="border border-stone-800 rounded-lg bg-stone-900 p-4 space-y-3">
      <div>
        <div className="text-sm font-medium text-stone-300">Chat IA (optionnel)</div>
        <p className="text-xs text-stone-500 mt-1">Les assistants utilisent l'API Anthropic. Sur cette version web, il faut ta propre clé. Sans clé, tout le reste fonctionne normalement.</p>
      </div>
      <div className="flex gap-2 flex-wrap items-end">
        <Field label="Clé API Anthropic"><input type="password" className={`${inputCls} w-72`} value={key} placeholder="sk-ant-..." onChange={e => setKey(e.target.value)} /></Field>
        <button onClick={save} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800">Enregistrer</button>
        {key && <button onClick={() => { setKey(''); setApiKey(''); }} className="text-sm px-3 py-1.5 rounded text-stone-400 hover:bg-stone-800">Effacer</button>}
        {saved && <span className="text-xs text-emerald-400">Enregistré</span>}
      </div>
      <div className="text-[11px] text-amber-300 bg-amber-950 border border-amber-800 rounded px-3 py-2">
        À savoir : la clé est stockée dans ton navigateur et envoyée directement à Anthropic depuis la page. Elle reste visible dans les outils de développement — acceptable pour un usage personnel, pas sur un appareil partagé. Créer une clé : console.anthropic.com
      </div>
    </div>
  );
}

function ProfilTab({ profile, setProfile, library, setLibrary }) {
  const [refKmStr, setRefKmStr] = useState(String(profile.refKm || ''));
  const [refTimeStr, setRefTimeStr] = useState(profile.refTimeStr || '');
  const [fcMaxStr, setFcMaxStr] = useState(String(profile.fcMax || ''));
  const [fcReposStr, setFcReposStr] = useState(String(profile.fcRepos || ''));
  const [applied, setApplied] = useState(false);

  const compute = () => {
    const refKm = parseFloat(refKmStr) || 0;
    const refSec = parseTimeToSeconds(refTimeStr);
    const fcMax = parseInt(fcMaxStr) || 0;
    const fcRepos = parseInt(fcReposStr) || 0;
    const zones = computeZones({ refKm, refSec, fcMax, fcRepos });
    setProfile({ ...profile, refKm, refTimeStr, fcMax, fcRepos, zones });
    setApplied(false);
  };

  const setHistory = (updater) => {
    const newHistory = typeof updater === 'function' ? updater(profile.history || []) : updater;
    setProfile({ ...profile, history: newHistory });
  };

  const applyToLibrary = () => {
    if (!profile.zones) return;
    setLibrary(applyZonesToLibrary(library, profile.zones));
    setApplied(true);
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <ApiKeyPanel />
      <h2 className="text-lg font-medium text-stone-200">Mes zones d'entraînement</h2>
      <p className="text-sm text-stone-500">
        Indique une performance de référence récente (une course ou un test chronométré) et, si tu les connais, ta FC max et ta FC repos.
        L'appli en déduit des zones d'allure et de FC approximatives (extrapolation de type Riegel) — à ajuster selon ton ressenti, ce n'est pas une science exacte.
      </p>
      <div className="border border-stone-800 rounded-lg bg-stone-900 p-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="block text-xs text-stone-500 mb-1">Distance de référence (km)</label>
            <input className="border border-stone-700 rounded px-2 py-1.5 text-sm w-28" value={refKmStr} onChange={e => setRefKmStr(e.target.value)} placeholder="10" />
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">Temps réalisé (mm:ss ou h:mm:ss)</label>
            <input className="border border-stone-700 rounded px-2 py-1.5 text-sm w-32" value={refTimeStr} onChange={e => setRefTimeStr(e.target.value)} placeholder="42:30" />
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">FC max (bpm)</label>
            <input className="border border-stone-700 rounded px-2 py-1.5 text-sm w-24" value={fcMaxStr} onChange={e => setFcMaxStr(e.target.value)} placeholder="188" />
          </div>
          <div>
            <label className="block text-xs text-stone-500 mb-1">FC repos (bpm, optionnel)</label>
            <input className="border border-stone-700 rounded px-2 py-1.5 text-sm w-24" value={fcReposStr} onChange={e => setFcReposStr(e.target.value)} placeholder="48" />
          </div>
          <button onClick={compute} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800">Calculer</button>
        </div>
      </div>

      {profile.zones && (
        <div className="border border-stone-800 rounded-lg bg-stone-900 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-950 text-stone-500 text-xs">
              <tr><th className="text-left px-3 py-2 font-medium">Zone</th><th className="text-left px-3 py-2 font-medium">Allure</th><th className="text-left px-3 py-2 font-medium">FC</th></tr>
            </thead>
            <tbody>
              {ZONE_LABELS.map(z => {
                const zone = profile.zones[z.key];
                return (
                  <tr key={z.key} className="border-t border-stone-900">
                    <td className="px-3 py-2 text-stone-200">{z.label}</td>
                    <td className="px-3 py-2 text-stone-400">{zone.paceKmh ? `${kmhToPace(zone.paceKmh[1])} – ${kmhToPace(zone.paceKmh[0])} /km` : '—'}</td>
                    <td className="px-3 py-2 text-stone-400">{zone.hr ? `${zone.hr[0]} – ${zone.hr[1]} bpm` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="p-3 border-t border-stone-900 flex items-center gap-3">
            <button onClick={applyToLibrary} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800">
              Appliquer ces zones à ma bibliothèque
            </button>
            {applied && <span className="text-xs text-emerald-400">Zones appliquées aux séances de la bibliothèque.</span>}
          </div>
        </div>
      )}

      <div className="pt-2 border-t border-stone-800">
        <HistorySection history={profile.history} setHistory={setHistory} />
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <div>
      <label className="block text-xs text-stone-500 mb-1">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-stone-600 mt-0.5">{hint}</div>}
    </div>
  );
}
const inputCls = 'border border-stone-700 rounded px-2 py-1.5 text-sm text-stone-100 bg-stone-900';

const PHASE_COLORS = {
  reprise: { bar: '#5DCAA5', bg: '#085041', text: '#9FE1CB' },
  charge: { bar: '#EF9F27', bg: '#633806', text: '#FAC775' },
  choc: { bar: '#F0997B', bg: '#712B13', text: '#F5C4B3' },
  picchoc: { bar: '#E4572E', bg: '#8A2208', text: '#FBD3C4' },
  recup: { bar: '#97C459', bg: '#27500A', text: '#C0DD97' },
  affutage: { bar: '#85B7EB', bg: '#0C447C', text: '#B5D4F4' },
  course: { bar: '#378ADD', bg: '#0C447C', text: '#B5D4F4' },
};
function PhaseTag({ phase, className = '' }) {
  const c = PHASE_COLORS[phase] || PHASE_COLORS.charge;
  return <span className={`text-xs px-2 py-0.5 rounded border ${className}`} style={{ backgroundColor: c.bg, color: c.text, borderColor: c.bar + '55' }}>{PHASE_LABELS[phase]}</span>;
}

function LoadCurveChart({ weeks, selectedKey, onSelect }) {
  if (!weeks.length) return null;
  const max = Math.max(...weeks.map(w => w.targetKmEq), 1);
  const barW = 100 / weeks.length;
  return (
    <div>
      {/* Macrocycle band above the bars: the coarse "what is this training
          for" layer, distinct from the per-week phase colours below. */}
      {weeks.some(w => w.macrocycle) && (() => {
        const segs = [];
        weeks.forEach((w, i) => {
          const m = w.macrocycle || 'developpement';
          const last = segs[segs.length - 1];
          if (last && last.m === m) last.n += 1; else segs.push({ m, n: 1, start: i });
        });
        return (
          <div className="flex w-full gap-0.5 mb-1">
            {segs.map((s, i) => (
              <div key={i} className="overflow-hidden rounded-sm" style={{ width: `${(s.n / weeks.length) * 100}%` }}>
                <div className="h-1.5 rounded-sm" style={{ backgroundColor: MACROCYCLES[s.m].color }} />
                <div className="text-[8px] mt-0.5 truncate text-center" style={{ color: MACROCYCLES[s.m].color }}>
                  {s.n / weeks.length > 0.12 ? MACROCYCLES[s.m].short : ''}
                </div>
              </div>
            ))}
          </div>
        );
      })()}
      <svg viewBox="0 0 300 70" className="w-full" style={{ height: 70 }} preserveAspectRatio="none">
        {weeks.map((w, i) => {
          const h = Math.max(2, (w.targetKmEq / max) * 60);
          const c = PHASE_COLORS[w.phase] || PHASE_COLORS.charge;
          const selected = w.weekKey === selectedKey;
          return (
            <g key={w.weekKey} style={{ cursor: 'pointer' }} onClick={() => onSelect && onSelect(w.weekKey)}>
              {/* Full-slot invisible tap target — the visible bar is often far
                  narrower than a usable touch target on long plans, so the
                  tappable area extends across the whole week's slot. */}
              <rect x={`${i * barW}%`} y={0} width={`${barW}%`} height={70} fill="transparent" />
              <rect x={`${i * barW + barW * 0.12}%`} y={64 - h} width={`${barW * 0.76}%`} height={h} rx="1.5" fill={c.bar}
                stroke={selected ? '#fff' : 'none'} strokeWidth={selected ? 1.5 : 0} style={{ opacity: selected ? 1 : 0.85, pointerEvents: 'none' }} />
              <title>{fmtShort(w.monday)} · {PHASE_LABELS[w.phase]} · {w.targetKmEq} km-éq · {w.targetVolumeKm} km · {w.targetDPlus} m D+</title>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-3 mt-2">
        {['reprise', 'charge', 'choc', 'recup', 'affutage'].map(p => (
          <span key={p} className="text-[10px] text-stone-500 flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: PHASE_COLORS[p].bar }} />{PHASE_LABELS[p]}
          </span>
        ))}
      </div>
    </div>
  );
}

// AI quiz to fill the Objectif form from free text — same pattern as the
// history quiz: parse, show an editable review, only commit on confirmation.
function ObjectifChatFill({ onFilled, onCancel }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState(null);
  const scrollRef = useRef(null);
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }); }, [messages, loading]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const next = [...messages, { role: 'user', content: input.trim() }];
    setMessages(next); setInput(''); setLoading(true);
    const systemPrompt = `Tu aides à remplir un formulaire de préparation trail depuis une description libre.
Champs à extraire : nom (texte), date (ISO yyyy-mm-dd), distanceKm (nombre), deniveleM (nombre, D+ en mètres), startKm (volume hebdo actuel en km), startDPlus (D+ hebdo actuel en m), currentWeeklyHours (heures hebdo actuelles), trainingDaysPerWeek (jours d'entraînement par semaine), taperWeeks (semaines d'affûtage souhaitées, défaut 2).
Si des champs importants manquent (surtout date et distance), pose une question ciblée dans ta réponse en texte avant de considérer le formulaire complet.
Réponds en français, brièvement, puis termine TOUJOURS par un bloc JSON avec les champs connus jusqu'ici (null si inconnu) :
\`\`\`json
{"nom":null,"date":null,"distanceKm":null,"deniveleM":null,"startKm":null,"startDPlus":null,"currentWeeklyHours":null,"trainingDaysPerWeek":null,"taperWeeks":null}
\`\`\``;
    try {
      const data = await callClaude({ model: 'claude-sonnet-4-6', max_tokens: 1000, system: systemPrompt, messages: next.map(m => ({ role: m.role, content: m.content })) });
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const m = /```json\s*([\s\S]*?)```/.exec(text);
      if (m) { try { setDraft(JSON.parse(m[1])); } catch { /* ignore */ } }
      const clean = text.replace(/```json[\s\S]*?```/, '').trim();
      setMessages(prev => [...prev, { role: 'assistant', content: clean || text }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: err instanceof MissingApiKeyError ? err.message : `Erreur : ${err.message || 'connexion impossible'}. Réessaie.` }]);
    } finally { setLoading(false); }
  };

  const hasMinimum = draft && draft.date && draft.distanceKm;

  return (
    <div className="border border-stone-800 rounded-lg bg-stone-900 overflow-hidden">
      <div className="flex flex-col h-[45vh] max-h-[380px]">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
          {messages.length === 0 && <p className="text-sm text-stone-600">Décris ta course et où tu en es en ce moment, en une fois : "Je prépare le Grand Trail des Cimes, 170km 10000D+, le 15 octobre 2027. Je tourne à 50km/semaine avec 1500m de D+ en ce moment, sur 5 jours."</p>}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'bg-emerald-700 text-white' : 'bg-stone-800 text-stone-200'}`}>{m.content}</div>
            </div>
          ))}
          {loading && <div className="text-sm text-stone-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Réflexion…</div>}
        </div>
        <div className="p-2.5 border-t border-stone-800 flex gap-2">
          <textarea className="flex-1 border border-stone-700 rounded-md px-2.5 py-1.5 text-sm resize-none bg-stone-900 text-stone-100" rows={2} value={input}
            onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button onClick={send} disabled={loading} className="px-3 py-1.5 rounded-md bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50 self-end"><Send size={16} /></button>
        </div>
      </div>
      {draft && (
        <div className="border-t border-stone-800 p-3 bg-stone-950 space-y-2">
          <div className="text-xs text-stone-500">Ce que j'ai compris — tu pourras tout corriger juste après :</div>
          <div className="text-sm text-stone-300 grid grid-cols-2 gap-x-4 gap-y-1">
            {draft.nom && <div>Course : <strong className="text-stone-100">{draft.nom}</strong></div>}
            {draft.date && <div>Date : <strong className="text-stone-100">{draft.date}</strong></div>}
            {draft.distanceKm && <div>Distance : <strong className="text-stone-100">{draft.distanceKm} km</strong></div>}
            {draft.deniveleM != null && <div>D+ : <strong className="text-stone-100">{draft.deniveleM} m</strong></div>}
            {draft.startKm != null && <div>Volume actuel : <strong className="text-stone-100">{draft.startKm} km/sem</strong></div>}
            {draft.currentWeeklyHours != null && <div>Temps hebdo : <strong className="text-stone-100">{draft.currentWeeklyHours} h</strong></div>}
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={() => onFilled(draft)} disabled={!hasMinimum} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-40">Continuer vers le formulaire</button>
            {!hasMinimum && <span className="text-[11px] text-stone-600 self-center">Il manque au moins la date ou la distance.</span>}
          </div>
        </div>
      )}
      <div className="p-2.5 border-t border-stone-800">
        <button onClick={onCancel} className="text-xs text-stone-500 hover:text-stone-300">← Revenir au choix</button>
      </div>
    </div>
  );
}

function initialObjectifState(o) {
  return {
    nom: o.nom || '', date: o.date || '', distanceKm: o.distanceKm || '', deniveleM: o.deniveleM || '',
    cutoffH: o.cutoffH || '', raceHoursEstimate: o.raceHoursEstimate || '', raceTimeStr: o.raceTimeStr || '',
    startKm: o.startKm ?? o.currentWeeklyKm ?? 50, startDPlus: o.startDPlus ?? o.currentWeeklyDPlus ?? 1000,
    currentWeeklyHours: o.currentWeeklyHours || 6,
    habitualKm: o.habitualKm || '', habitualDPlus: o.habitualDPlus || '',
    peakKmEq: o.peakKmEq || '',
    trainingDaysPerWeek: o.trainingDaysPerWeek || 5, taperWeeks: o.taperWeeks ?? 2,
    experienceTier: o.experienceTier || null, planStartDate: o.planStartDate || '',
    fractionneDuJeudi: o.fractionneDuJeudi ?? false,
    specificity: o.specificity ?? 0.75, chocDayOverrides: o.chocDayOverrides || {}, dayAvailability: o.dayAvailability || {},
    disciplineObjectif: o.disciplineObjectif || 'trail',
  };
}

// One question, one screen — used only for a brand-new objective. A returning
// objective skips straight to the full view (see ObjectifTab below).
function QuestionShell({ qIndex, total, title, subtitle, children, onNext, onBack, nextDisabled, nextLabel = 'Suivant', canSkip, onSkip, onCancelAll }) {
  return (
    <div key={qIndex} className="qanim space-y-4">
      <style>{`@keyframes qfade { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } } .qanim { animation: qfade 0.28s ease-out; }`}</style>
      <div className="flex items-center gap-2">
        {Array.from({ length: total }).map((_, i) => (
          <div key={i} className="flex-1 h-1.5 rounded-full bg-stone-800 overflow-hidden">
            <div className="h-full bg-emerald-600 transition-all duration-300" style={{ width: i <= qIndex ? '100%' : '0%' }} />
          </div>
        ))}
      </div>
      <div className="border border-stone-800 rounded-lg bg-stone-900 p-6 space-y-5">
        <div>
          <div className="text-lg font-medium text-stone-100">{title}</div>
          {subtitle && <div className="text-sm text-stone-500 mt-1">{subtitle}</div>}
        </div>
        <div>{children}</div>
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-3">
            {qIndex > 0 && <button onClick={onBack} className="text-sm text-stone-500 hover:text-stone-300">← Précédent</button>}
            {onCancelAll && <button onClick={onCancelAll} className="text-sm text-stone-600 hover:text-stone-400">Annuler</button>}
          </div>
          <div className="flex gap-2 items-center">
            {canSkip && <button onClick={onSkip} className="text-sm text-stone-500 hover:text-stone-300">Passer</button>}
            <button onClick={onNext} disabled={nextDisabled} className="text-sm px-4 py-2 rounded bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-40">{nextLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Centralised duration display (spec §22): never show "11.5 h" to a user.
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(total / 60), m = total % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
}
function fmtHoursLabel(h) { return formatDuration((h || 0) * 60); }

function PlanResults({ preview, chocWeeks, picChocBlock, D, selectedWeekKey, setSelectedWeekKey, confirming, setConfirming, doGenerate, showDetail, setShowDetail, onExtendWeekend }) {
  // Arrow keys step through weeks — natural on desktop where the chart bars
  // are small targets. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!preview.length) return;
      const curKey = selectedWeekKey || (preview[0] && preview[0].weekKey);
      const idx = preview.findIndex(w => w.weekKey === curKey);
      if (idx < 0) return;
      const next = e.key === 'ArrowRight' ? Math.min(preview.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (next !== idx) { e.preventDefault(); setSelectedWeekKey(preview[next].weekKey); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, selectedWeekKey, setSelectedWeekKey]);
  if (!preview.length) return null;
  const thisWeek = preview[0];
  const defaultFocus = picChocBlock[0] || chocWeeks[0] || thisWeek;
  const focusWeek = (selectedWeekKey && preview.find(w => w.weekKey === selectedWeekKey)) || defaultFocus;
  const focusIdx = preview.findIndex(w => w.weekKey === focusWeek.weekKey);
  const prevWeek = focusIdx > 0 ? preview[focusIdx - 1] : null;
  const deltaPct = prevWeek && prevWeek.targetKmEq > 0
    ? Math.round(((focusWeek.targetKmEq - prevWeek.targetKmEq) / prevWeek.targetKmEq) * 100) : null;
  const isChocFocus = (focusWeek.phase === 'choc' || focusWeek.phase === 'picchoc') && focusWeek.weekend;
  const colors = PHASE_COLORS[focusWeek.phase] || PHASE_COLORS.charge;
  const sunday = addDays(focusWeek.monday, 6);
  const roadPrep = D && D.roadPreparation;

  return (
    <>
      {roadPrep && (
        <div className="mb-4 rounded-lg border border-emerald-900 bg-emerald-950/30 p-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div><div className="text-xs uppercase tracking-wide text-emerald-400">Temps nécessaire Route</div><div className="text-xl font-semibold text-stone-100">≈ {roadPrep.totalWeeks} semaines</div></div>
            <div className="text-xs text-stone-400">Facteur limitant : {roadPrep.limitingFactor === 'volume' ? 'volume' : roadPrep.limitingFactor === 'speed' ? 'vitesse' : 'spécificité'}</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-xs">
            <div className="bg-stone-950/60 rounded p-2"><span className="text-stone-500 block">Volume</span><strong>{roadPrep.volumeWeeks} sem.</strong></div>
            <div className="bg-stone-950/60 rounded p-2"><span className="text-stone-500 block">Vitesse</span><strong>{roadPrep.speedWeeks} sem.</strong></div>
            <div className="bg-stone-950/60 rounded p-2"><span className="text-stone-500 block">Spécificité</span><strong>{roadPrep.specificityWeeks} sem.</strong></div>
            <div className="bg-stone-950/60 rounded p-2"><span className="text-stone-500 block">Affûtage</span><strong>{roadPrep.taperWeeks} sem.</strong></div>
          </div>
          {roadPrep.goalStatus === 'ambitious' && <div className="text-[11px] text-amber-300 mt-2">Écart de performance supérieur à 20 % : estimation plafonnée, à revalider après un test.</div>}
        </div>
      )}
      {/* Chart first — it's the most useful thing on the page. On wide
          screens the selected-week detail sits alongside it instead of below,
          so the extra width is actually used. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-4 lg:items-start space-y-4 lg:space-y-0">
      <div className="border border-stone-800 rounded-lg bg-stone-900 p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-stone-300">Charge sur {preview.length} semaines</span>
          <span className="text-xs text-stone-500">clique une semaine <span className="hidden lg:inline">ou utilise ← →</span></span>
        </div>
        <LoadCurveChart weeks={preview} selectedKey={focusWeek.weekKey} onSelect={setSelectedWeekKey} />

        {/* Metrics follow the SELECTED week, not a fixed "this week". */}
        <div className="flex items-center justify-between mt-4 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            {focusWeek.macrocycle && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border" style={{ color: MACROCYCLES[focusWeek.macrocycle].color, borderColor: MACROCYCLES[focusWeek.macrocycle].color + '66' }}>
                {MACROCYCLES[focusWeek.macrocycle].label}
              </span>
            )}
            <PhaseTag phase={focusWeek.phase} />
            {focusWeek.atPeak && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-200 border border-emerald-700">volume max atteint</span>}
            <span className="text-sm text-stone-300">{fmtShort(focusWeek.monday)} → {fmtShort(sunday)}</span>
          </div>
          <span className="text-xs text-stone-500">
            {focusWeek.weeksBeforeRace === 0 ? 'jour J' : `J-${focusWeek.weeksBeforeRace} sem.`}
          </span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="bg-stone-950 rounded-md p-2 text-center">
            <div className="text-lg font-semibold text-stone-200">{focusWeek.targetVolumeKm}</div>
            <div className="text-[11px] text-stone-500">km</div>
          </div>
          <div className="bg-stone-950 rounded-md p-2 text-center">
            <div className="text-lg font-semibold text-stone-200">{focusWeek.targetDPlus}</div>
            <div className="text-[11px] text-stone-500">m D+</div>
          </div>
          <div className="bg-stone-950 rounded-md p-2 text-center">
            <div className="text-lg font-semibold text-stone-200">{fmtHoursLabel(focusWeek.targetHours)}</div>
            <div className="text-[11px] text-stone-500">temps</div>
          </div>
          <div className="bg-stone-950 rounded-md p-2 text-center">
            <div className={`text-lg font-semibold ${deltaPct == null ? 'text-stone-500' : deltaPct > 0 ? 'text-amber-300' : deltaPct < 0 ? 'text-emerald-400' : 'text-stone-300'}`}>
              {deltaPct == null ? '—' : `${deltaPct > 0 ? '+' : ''}${deltaPct}%`}
            </div>
            <div className="text-[11px] text-stone-500">vs sem. préc.</div>
          </div>
        </div>
        {focusWeek.note && <div className="text-[11px] text-stone-500 mt-2">{focusWeek.note}</div>}
      </div>

      {/* Detail of the selected week: weekend breakdown when relevant. */}
      {isChocFocus && (
        <div className="rounded-lg p-4 lg:col-start-2 lg:row-start-1 lg:self-start" style={{ backgroundColor: colors.bg }}>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5" style={{ color: colors.text }}>
              <Flame size={15} />
              <span className="text-xs">
                {focusWeek.weekend.isPicChoc
                  ? `${focusWeek.weekend.isTransition ? 'PIC CHOC de transition' : 'PIC CHOC final'} — semaine ${focusWeek.weekend.part}/2`
                  : `Week-end choc${focusWeek.weekend.isLast ? ' (dernier)' : ''}`}
              </span>
            </div>
            {selectedWeekKey && <button onClick={() => setSelectedWeekKey(null)} className="text-[11px] underline" style={{ color: colors.text }}>revenir au bloc clé</button>}
          </div>
          <div className="text-base font-medium mb-1" style={{ color: colors.text }}>{fmtShort(focusWeek.monday)}</div>
          {focusWeek.weekend.isPicChoc && (
            <div className="text-[11px] mb-2" style={{ color: colors.text, opacity: 0.9 }}>
              Volume maximal de la prépa : {focusWeek.targetKmEq} km-éq cette semaine
              {focusWeek.weekend.weekPctOfRace ? ` (~${focusWeek.weekend.weekPctOfRace} % du temps de course)` : ''}, tenu 2 semaines de suite sans coupure.
            </div>
          )}
          <div className="space-y-2">
            {focusWeek.weekend.perDayHours.map((h, i) => {
              const s = focusWeek.weekend.splits[i];
              const labels = { 2: ['Samedi', 'Dimanche'], 3: ['Vendredi', 'Samedi', 'Dimanche'], 4: ['Vendredi', 'Samedi', 'Dimanche', 'Lundi'] };
              const dayLabel = (labels[focusWeek.weekend.days] || [])[i] || `Jour ${i + 1}`;
              return (
                <div key={i} className="bg-stone-900/70 rounded-md p-2.5">
                  <div className="flex justify-between items-baseline">
                    <span className="text-sm font-medium text-stone-200">{dayLabel}</span>
                    <span className="text-xs text-stone-500">{fmtHoursLabel(h)}</span>
                  </div>
                  <div className="text-sm text-stone-300 mt-0.5">{Math.round(focusWeek.weekend.km * s * 10) / 10} km · {Math.round(focusWeek.weekend.dplus * s)} m D+</div>
                </div>
              );
            })}
          </div>
          <div className="flex justify-between pt-2 mt-2 border-t" style={{ borderColor: colors.bar + '55' }}>
            <span className="text-xs" style={{ color: colors.text }}>Week-end : {fmtHoursLabel(focusWeek.weekend.hours)}</span>
            {focusWeek.weekend.pctOfRace != null && <span className="text-xs font-medium" style={{ color: colors.text }}>{focusWeek.weekend.pctOfRace} % de la course</span>}
          </div>
          {/* Holiday extension: per-block, not a global setting. */}
          {onExtendWeekend && (
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="text-[11px]" style={{ color: colors.text, opacity: 0.85 }}>En vacances cette semaine-là ?</span>
              {[2, 3, 4].map(n => (
                <button key={n} onClick={() => onExtendWeekend(focusWeek.weekKey, n)}
                  className={`text-[11px] px-2 py-1 rounded border ${focusWeek.weekend.days === n ? 'bg-stone-900 border-stone-500 text-stone-100' : 'border-stone-700 text-stone-400 hover:border-stone-500'}`}>
                  {n} jours
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {!confirming ? (
          <button onClick={() => setConfirming(true)} className="text-sm px-4 py-2 rounded bg-emerald-700 text-white hover:bg-emerald-800">Générer le plan jusqu'à la course</button>
        ) : (
          <>
            <span className="text-sm text-stone-400">Cela remplace les séances déjà planifiées sur ces {preview.length} semaines.</span>
            <button onClick={doGenerate} className="text-sm px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-800">Confirmer</button>
            <button onClick={() => setConfirming(false)} className="text-sm px-3 py-1.5 rounded text-stone-400 hover:bg-stone-800">Annuler</button>
          </>
        )}
        <button onClick={() => setShowDetail(s => !s)} className="text-sm text-stone-500 hover:text-stone-200 flex items-center gap-1">
          <ChevronDown size={14} className={`transition-transform ${showDetail ? 'rotate-180' : ''}`} />
          {showDetail ? 'Masquer le détail' : 'Voir le détail semaine par semaine'}
        </button>
      </div>

      {showDetail && (
        <div className="border border-stone-800 rounded-lg bg-stone-900 overflow-hidden">
          <div className="px-3 py-2 border-b border-stone-800 text-sm text-stone-400">{preview.length} semaine(s) jusqu'à la course. Le km-effort pilote en coulisses ; km, D+ et heures sont ce qui compte au quotidien.</div>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-stone-950 text-stone-500 text-xs sticky top-0"><tr>
                <th className="text-left px-3 py-1.5 font-medium">Semaine</th>
                <th className="text-left px-3 py-1.5 font-medium">Phase</th>
                <th className="text-left px-3 py-1.5 font-medium">km</th>
                {D.strategy.usesChocWeekends && <th className="text-left px-3 py-1.5 font-medium">D+</th>}
                <th className="text-left px-3 py-1.5 font-medium">Temps</th>
                {D.strategy.usesChocWeekends && <th className="text-left px-3 py-1.5 font-medium hidden sm:table-cell">km-éq</th>}
                {D.strategy.usesChocWeekends && <th className="text-left px-3 py-1.5 font-medium hidden sm:table-cell">Ratio</th>}
              </tr></thead>
              <tbody>
                {preview.map(w => (
                  <tr key={w.weekKey} onClick={() => setSelectedWeekKey(w.weekKey)}
                    className={`border-t border-stone-800 cursor-pointer hover:bg-stone-950 ${w.weekKey === focusWeek.weekKey ? 'bg-stone-950' : ''}`}>
                    <td className="px-3 py-1.5 whitespace-nowrap">{fmtShort(w.monday)}</td>
                    <td className="px-3 py-1.5">
                      <PhaseTag phase={w.phase} />
                    </td>
                    <td className="px-3 py-1.5 text-stone-200 font-medium">{w.targetVolumeKm}</td>
                    {D.strategy.usesChocWeekends && <td className="px-3 py-1.5 text-stone-200 font-medium">{w.targetDPlus}</td>}
                    <td className="px-3 py-1.5 text-stone-200 font-medium">{fmtHoursLabel(w.targetHours)}</td>
                    {D.strategy.usesChocWeekends && <td className="px-3 py-1.5 text-stone-500 hidden sm:table-cell">{w.targetKmEq}</td>}
                    {D.strategy.usesChocWeekends && <td className="px-3 py-1.5 text-stone-500 hidden sm:table-cell">{w.ratio}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 text-xs text-stone-600 border-t border-stone-800">
            {D.strategy.usesChocWeekends
              ? `Ratio = m de D+ par km-éq ; il converge vers celui de ta course (${Math.round(D.raceRatio)}). Le km-effort sous-estime l'effort au-delà de 50 km et sur terrain technique — les heures affichées sont un plancher, pas une promesse.`
              : `Volumes en kilomètres. Les allures sont des repères calculés depuis ta référence : elles valent ce que vaut cette référence, et se réajustent si tu la mets à jour.`}
          </div>
        </div>
      )}
    </>
  );
}

function ObjectifTab({ objectif, onGenerate, library, profile, onGoToProfil }) {
  const o = objectif;
  const history = profile && profile.history ? profile.history : [];
  const [d, setD] = useState(() => initialObjectifState(o));
  const [confirming, setConfirming] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [selectedWeekKey, setSelectedWeekKey] = useState(null);
  const [fillMode, setFillMode] = useState(o.date ? 'flat' : 'sequential'); // 'sequential' | 'flat'
  const [qIndex, setQIndex] = useState(0);
  const num = (v) => parseFloat(v) || 0;

  const profileRef = (profile && profile.refKm && profile.refTimeStr)
    ? { refKm: profile.refKm, refSec: parseTimeToSeconds(profile.refTimeStr) } : null;

  const parsed = {
    ...d, distanceKm: num(d.distanceKm), deniveleM: num(d.deniveleM), cutoffH: num(d.cutoffH), raceHoursEstimate: num(d.raceHoursEstimate),
    startKm: num(d.startKm), startDPlus: num(d.startDPlus), currentWeeklyHours: num(d.currentWeeklyHours),
    habitualKm: num(d.habitualKm), habitualDPlus: num(d.habitualDPlus), peakKmEq: num(d.peakKmEq),
    trainingDaysPerWeek: parseInt(d.trainingDaysPerWeek) || 5, taperWeeks: parseInt(d.taperWeeks) || 0,
    specificity: Math.min(1, Math.max(0.5, num(d.specificity) || 1)),
    profileRef, history, fractionneDuJeudi: !!d.fractionneDuJeudi,
  };
  const D = deriveObjectif(parsed);
  const effectiveTier = D.effectiveTier;
  const preview = buildPeriodizationPlan(parsed);
  // The plan now generates any session type it needs, so a partial library is
  // no longer a problem worth warning about.
  const missingTypes = [];
  const chocWeeks = preview.filter(w => w.phase === 'choc');
  const picChocBlock = preview.filter(w => w.phase === 'picchoc');
  const lastChoc = chocWeeks[chocWeeks.length - 1];
  const picChocNote = (() => {
    if (!lastChoc || !lastChoc.weekend) return null;
    const anyPicChoc = chocWeeks.some(w => w.weekend.isPicChoc);
    if (anyPicChoc) return null;
    const threshold = D.chocWeekendCapHours;
    const ratio = lastChoc.weekend.hours / threshold;
    if (ratio > 0.9) return `Ton dernier week-end choc atteint ${formatDuration(lastChoc.weekend.hours*60)}, tout près du seuil de ${formatDuration(threshold*60)} au-delà duquel l'appli basculerait en PIC CHOC (étalé sur 2 semaines) — encore gérable sur ${lastChoc.weekend.days} jours, mais à la limite.`;
    return null;
  })();
  const lastBuildWeek = [...preview].reverse().find(w => w.phase !== 'affutage' && w.phase !== 'course');
  const hasUsableHistory = history.some(e => disciplineConfig(e.discipline).runLike || e.tempsSec);
  // The plan was generated against a given history; if it has grown since, the
  // tier, the race-time estimate and the peak volume would all be different.
  const planHistorySize = o.historySignature;
  const historyChanged = planHistorySize != null && history.length !== planHistorySize;

  const raceDateObj = parseISODate(parsed.date);
  let idealStart = null;
  let tierComparison = null;
  if (raceDateObj && D.peakKmEq) {
    const weeksNeeded = D.roadPreparation ? D.roadPreparation.totalWeeks : weeksToReachPeak(D.startKmEq, D.peakKmEq, parsed.trainingDaysPerWeek, effectiveTier) + parsed.taperWeeks;
    const raceMonday = getMonday(raceDateObj);
    const idealMonday = addDays(raceMonday, -weeksNeeded * 7);
    // Same rule as the engine: the earliest a plan can actually begin is the
    // upcoming Monday, not the current (already-started) week.
    const todayMonday = getMonday(new Date());
    const earliestStart = (new Date().getDay() === 1) ? todayMonday : addDays(todayMonday, 7);
    const slackWeeks = Math.round((earliestStart - idealMonday) / (7 * 24 * 3600 * 1000));
    idealStart = { date: idealMonday, weeksNeeded, slackWeeks, earliestStart, canWait: slackWeeks < 0 };
    const totalWeeksAvailable = Math.round((raceMonday - todayMonday) / (7 * 24 * 3600 * 1000));
    // The week counts must be comparable to each other. Previously each row
    // reused D.peakKmEq, which — when there's no history and no target time —
    // is itself derived from the SELECTED tier's pace band. Selecting a tier
    // therefore moved all three numbers at once, which is why the same tier
    // showed a different week count depending on what was selected. Compute
    // every row against one fixed reference peak instead.
    const referencePeak = D.referencePeakKmEq || D.peakKmEq;
    // The taper also has to be a constant across rows: it stretches by a week
    // when a PIC CHOC block is present, and whether that happens depends on
    // the estimated race time — which itself depends on the selected tier.
    // Left unpinned, every row shifted by one week on each selection.
    const referenceTaper = (parsed.taperWeeks ?? 2) + (D.picChocLikely ? 1 : 0);
    tierComparison = Object.keys(TIER_LABELS).map(t => {
      const weeks = D.strategy.usesChocWeekends
        ? weeksToReachPeak(D.startKmEq, referencePeak, parsed.trainingDaysPerWeek, t) + referenceTaper
        : estimateRoadPreparationWeeks({ distance: parsed.distanceKm, startKmEq: D.startKmEq, peakKmEq: referencePeak, trainingDays: parsed.trainingDaysPerWeek, tier: t, currentTimeSec: D.paceRefKm && D.paceRefSec && parsed.distanceKm ? riegelSecondsFor(D.paceRefKm, D.paceRefSec, parsed.distanceKm) : 0, goalTimeSec: parsed.raceHoursEstimate ? parsed.raceHoursEstimate * 3600 : 0, hasReliableBenchmark: !!(D.paceRefKm && D.paceRefSec), taperWeeks: parsed.taperWeeks }).totalWeeks;
      return { tier: t, weeks, fits: weeks <= totalWeeksAvailable };
    });
  }

  const warnings = [];
  if (D.habitualKmEq && D.startKmEq > D.habitualKmEq * 1.3) {
    warnings.push({ title: 'Volume de départ ambitieux', text: `Tu veux démarrer à ${Math.round(D.startKmEq)} km-éq/semaine alors que tes 4 dernières semaines tournent autour de ${Math.round(D.habitualKmEq)} km-éq. C'est +${Math.round((D.startKmEq / D.habitualKmEq - 1) * 100)} % d'un coup : ça se fait pour un coureur expérimenté, mais les premières semaines seront le point de fragilité du plan.` });
  } else if (!D.habitualKmEq && D.startKmEq > ({ standard: 45, aguerri: 70, tres_experimente: 100 }[effectiveTier] || 45)) {
    warnings.push({ title: 'Volume de départ non vérifié', text: `Tu démarres à ~${Math.round(D.startKmEq)} km-éq/semaine sans avoir indiqué ton volume réel des 4 dernières semaines. Si ce n'est pas déjà ton rythme habituel, c'est un vrai facteur de risque de blessure quel que soit ton niveau général — renseigne "Volume réel 4 dernières semaines" pour une évaluation plus précise, ou baisse le point de départ si ce n'est pas encore ton quotidien.` });
  }
  if (idealStart && idealStart.slackWeeks > 0) {
    warnings.push({ title: 'Progression trop rapide pour le temps disponible', text: `Pour atteindre ton pic visé (~${Math.round(D.peakKmEq)} km-éq) en toute sécurité, il aurait fallu démarrer le ${fmtShort(idealStart.date)} — soit ${idealStart.slackWeeks} semaine(s) plus tôt. ${effectiveTier === 'tres_experimente' ? "Même au palier le plus rapide le temps manque : repousse la course, démarre plus haut, ou baisse la spécificité du dernier choc." : 'Passe au palier "Aguerri" ou "Très expérimenté" pour comprimer la progression, ou démarre plus haut.'}` });
  }
  if (parsed.peakKmEq && parsed.peakKmEq < D.recommendedPeakKmEq * 0.9) {
    warnings.push({ title: 'Pic visé faible', text: `Ton pic à ${parsed.peakKmEq} km-éq ne laisse pas la place au dernier week-end choc (~${Math.round(D.lastWeekendKmEq)} km-éq, soit ${formatDuration(D.lastWeekendHoursTarget*60)}). Le pic conseillé est ~${D.recommendedPeakKmEq} km-éq — laisse le champ vide pour l'utiliser.` });
  }
  // --- Availability checks: a plan the calendar can't hold is a plan that
  // will be crammed into the weekend, which is exactly how people get hurt.
  {
    const avail = parsed.dayAvailability || {};
    const weekdayKeys = ['lun', 'mar', 'mer', 'jeu', 'ven'];
    const weekdayCapacity = weekdayKeys.reduce((s, k) => s + Math.min(dayCapacityHours(avail, k), 4), 0);
    const peakWeek = preview.reduce((best, w) => (!best || w.targetHours > best.targetHours) ? w : best, null);
    if (peakWeek && weekdayCapacity > 0) {
      // Rough split: the weekend can realistically absorb ~60-65% of a big week.
      const weekdayNeed = peakWeek.targetHours * 0.38;
      if (weekdayNeed > weekdayCapacity) {
        warnings.push({
          title: 'Disponibilités insuffisantes en semaine',
          text: `Ta semaine la plus chargée demande environ ${formatDuration(weekdayNeed*60)} en milieu de semaine, mais tes créneaux n'en offrent que ${formatDuration(weekdayCapacity*60)}. Ajoute un second créneau sur une ou deux journées (matin + soir) — sinon tout le volume se reporte sur le week-end, ce qui concentre la charge et augmente le risque de blessure.`,
        });
      }
    }
    const earlyIdle = ['lun', 'mar', 'mer'].filter(k => dayCapacityHours(avail, k) === 0);
    if (earlyIdle.length >= 2) {
      warnings.push({
        title: 'Charge concentrée en fin de semaine',
        text: `Tu n'as aucun créneau sur ${earlyIdle.length} jours en début de semaine. Tout le volume se retrouve tassé sur la fin de semaine et le week-end : c'est un pic de charge aiguë sur peu de jours, le profil le plus associé aux blessures. Si tu peux libérer ne serait-ce qu'une heure en début de semaine, le plan sera nettement plus sûr.`,
      });
    }
  }

  if (D.goalAssessment && (D.goalAssessment.level === 'high' || D.goalAssessment.level === 'stretch')) {
    warnings.push({
      title: D.goalAssessment.level === 'high' ? 'Objectif de temps très ambitieux' : 'Objectif de temps ambitieux',
      text: `${D.goalAssessment.text} Ta référence laisse prévoir plutôt ${formatDuration(D.goalAssessment.predicted / 60)}. Le plan est construit sur ton objectif — libre à toi, mais tu sais où tu mets les pieds.`,
    });
  }
  if (lastChoc && lastChoc.weekend.overMax) {
    warnings.push({ title: 'Journée de choc au-dessus du plafond', text: `Le dernier week-end choc demande jusqu'à ${Math.max(...lastChoc.weekend.perDayHours)} h sur une journée, juste au-dessus du plafond de ${D.maxHoursPerDay} h, même réparti sur ${lastChoc.weekend.days} jours. Baisse la spécificité pour revenir dans une zone sûre.` });
  }

  // Not a warning: when the race is too long for any single weekend, PIC CHOC
  // takes over. That's the designed behaviour, so it's presented as
  // information about how the plan is built, not as something gone wrong.
  const planInfo = [];
  if (D.roadPaces && !D.strategy.usesChocWeekends) {
    planInfo.push({
      title: 'Tes allures d\'entraînement',
      paces: D.roadPaces,
      text: `Calculées depuis ta performance de référence (${D.paceRefKm} km en ${formatDuration(D.paceRefSec / 60)}). Ce sont des repères proposés : ajuste-les si tu te connais mieux que la formule.`,
    });
  }
  if (!D.strategy.usesChocWeekends && parsed.distanceKm > 0 && ![10, 21.1, 42.2].some(d => Math.abs(parsed.distanceKm - d) / d < 0.12)) {
    planInfo.push({
      title: 'Distance non optimisée',
      text: `Le moteur route est optimisé pour 10 km, semi et marathon. Pour ${parsed.distanceKm} km, l'appli applique le profil « ${D.roadProfileInfo.label} » : le plan reste cohérent, mais les progressions et le calendrier des tests sont calibrés sur la distance de référence — correct plutôt qu'optimal.`,
    });
  }
  if (!D.strategy.usesChocWeekends && D.recommendedPeakKmEq) {
    planInfo.push({
      title: 'Volume conseillé',
      text: `Pic conseillé : ~${D.recommendedPeakKmEq} km/semaine, à atteindre sur le dernier tiers de la prépa. Tu pars de ${Math.round(D.startKmEq)} km/semaine. Tu peux forcer une autre valeur dans les détails de l'objectif — repère utile : une étude sur 917 finishers de Boston associe 64-68 km/semaine aux meilleurs temps, et un objectif chronométré sérieux demande d'avoir tenu 50+ km/semaine pendant 2-3 mois avant de commencer.`,
    });
  }
  if (D.autoRoadLogic) {
    planInfo.push({
      title: 'Préparation de type route',
      text: `Ta course fait ${Math.round(D.raceKmEq)} km-éq : à cette distance, ce n'est pas la montée en volume qui fait la différence mais le travail en zones et les sorties à intensité course. L'appli bascule donc sur une logique de type route — les week-ends choc et la jauge de spécificité ne s'appliquent pas ici.`,
    });
  }
  if (picChocBlock.length) {
    const trans = picChocBlock.filter(w => w.isTransitionBlock);
    const finals = picChocBlock.filter(w => !w.isTransitionBlock);
    const f1 = finals[0] || picChocBlock[0];
    const pct = D.raceKmEq ? Math.round((f1.targetKmEq / D.raceKmEq) * 100) : null;
    planInfo.push({
      title: 'Ta prépa passe par un bloc PIC CHOC',
      text: `Ta course (${formatDuration(D.raceHoursLow*60)}-${formatDuration(D.raceHoursHigh*60)} estimées) est trop longue pour être répétée sur un seul week-end. À la place, l'appli programme ${trans.length ? 'deux blocs' : 'un bloc'} de 2 semaines consécutives sans coupure. ${trans.length ? `Un bloc de transition à partir du ${fmtShort(trans[0].monday)} (${trans[0].targetKmEq} km-éq/sem) prépare le corps à tenir un gros volume hebdomadaire, puis le ` : 'Le '}bloc final à partir du ${fmtShort(f1.monday)} atteint ${f1.targetKmEq} km-éq/semaine${pct ? ` — soit ${pct} % du volume de ta course, chaque semaine` : ''}. C'est le pic de toute ta préparation.`,
    });
  }

  const doGenerate = () => { onGenerate(parsed, preview); setConfirming(false); };
  const raceTimeHint = D.raceHoursSource === 'manuel' ? null
    : D.raceHoursSource === 'historique' ? `estimé ${formatDuration(D.raceHoursLow*60)}-${formatDuration(D.raceHoursHigh*60)} (d'après : ${D.raceHoursSourceLabel})`
    : D.raceHoursSource === 'profil' ? `estimé ${formatDuration(D.raceHoursLow*60)}-${formatDuration(D.raceHoursHigh*60)} (depuis ton profil)`
    : D.raceHoursSource === 'tier' ? `estimé ${formatDuration(D.raceHoursLow*60)}-${formatDuration(D.raceHoursHigh*60)} (palier ${TIER_LABELS[effectiveTier]}, large)` : null;

  const startNewObjectif = () => { setD(initialObjectifState({})); setFillMode('sequential'); setQIndex(0); setConfirming(false); };
  // Leaving the questionnaire: go back to the saved objective if there is one,
  // otherwise just exit to the full form with whatever has been entered.
  const hasSavedObjectif = !!o.date;
  const cancelSequential = () => {
    if (hasSavedObjectif) setD(initialObjectifState(o));
    setFillMode('flat'); setQIndex(0);
  };

  const TOTAL_Q = 11;
  const next = () => setQIndex(i => Math.min(TOTAL_Q, i + 1));
  const back = () => setQIndex(i => Math.max(0, i - 1));
  const finishSequential = () => setFillMode('flat');

  return (
    <div className="space-y-4 max-w-4xl lg:max-w-none">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-stone-200">Mon objectif</h2>
          <p className="text-sm text-stone-500 mt-1">Renseigne ta course et ton point de départ : l'appli construit le plan jusqu'au jour J en km-effort (km + D+/100), avec un week-end choc tous les 4 semaines qui monte jusqu'à la durée de ta course.</p>
        </div>
        {fillMode === 'flat' && <button onClick={startNewObjectif} className="text-sm px-3 py-1.5 rounded border border-stone-700 text-stone-300 hover:border-emerald-700 shrink-0">Nouvel objectif</button>}
      </div>

      {historyChanged && fillMode === 'flat' && (
        <div className="text-sm text-sky-200 bg-sky-950 border border-sky-800 rounded px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
          <span>
            Ton historique a changé depuis la génération de ce plan ({planHistorySize} → {history.length} entrées).
            Il détermine ton palier, l'estimation de ton temps de course et donc le volume de pic — le plan serait différent.
          </span>
          <button onClick={() => setConfirming(true)} className="text-sm font-medium underline shrink-0">Recalculer le plan</button>
        </div>
      )}
      {!hasUsableHistory && (
        <div className="text-sm text-red-400 bg-red-950 border border-red-800 rounded px-3 py-2 flex items-center justify-between gap-3">
          <span>⚠️ Estimation et calcul du plan moins fiables sans ton historique.</span>
          {onGoToProfil && <button onClick={onGoToProfil} className="text-sm font-medium underline shrink-0">Renseigne-le dans Profil →</button>}
        </div>
      )}

      {fillMode === 'sequential' && (
        <>
          {preview.length > 0 && (
            <div className="border border-stone-800 rounded-lg bg-stone-900 p-3">
              <div className="text-xs text-stone-500 mb-2">Ton plan prend forme…</div>
              <LoadCurveChart weeks={preview} selectedKey={null} onSelect={() => {}} />
            </div>
          )}

          {qIndex === 0 && (
            <QuestionShell qIndex={0} total={TOTAL_Q} onCancelAll={cancelSequential} title="Route ou trail ?" subtitle="Les deux ne se préparent pas du tout pareil : le trail se construit sur la montée en volume et le dénivelé, la route sur le travail en zones et les allures spécifiques." onNext={next} nextDisabled={false}>
              <div className="flex flex-col sm:flex-row gap-3">
                {[
                  { v: 'trail', l: 'Trail / Ultra', d: 'Dénivelé, week-ends choc, volume sur les pieds' },
                  { v: 'route', l: 'Route', d: 'Zones, allures cibles, sorties à intensité course' },
                ].map(opt => (
                  <button key={opt.v} onClick={() => setD({ ...d, disciplineObjectif: opt.v })}
                    className={`flex-1 text-left px-4 py-4 rounded-lg border ${d.disciplineObjectif === opt.v ? 'border-emerald-600 bg-emerald-950' : 'border-stone-700 hover:border-stone-500'}`}>
                    <div className={d.disciplineObjectif === opt.v ? 'text-emerald-300 font-medium' : 'text-stone-200 font-medium'}>{opt.l}</div>
                    <div className="text-xs text-stone-500 mt-1">{opt.d}</div>
                  </button>
                ))}
              </div>
              {d.disciplineObjectif === 'route' && (
                <div className="text-[11px] text-amber-300 bg-amber-950 border border-amber-800 rounded px-3 py-2 mt-3">
                  La logique route n'est pas encore complète : le moteur actuel est construit autour de la montée en volume et du dénivelé. Un plan route est généré, mais le travail en zones et les allures cibles arrivent dans une prochaine version.
                </div>
              )}
            </QuestionShell>
          )}
          {qIndex === 1 && (
            <QuestionShell qIndex={1} total={TOTAL_Q} onCancelAll={cancelSequential} title="Comment s'appelle ta course ?" onNext={next} nextDisabled={false} canSkip onSkip={next}>
              <input className={`${inputCls} w-full text-lg py-3`} value={d.nom} onChange={e => setD({ ...d, nom: e.target.value })} placeholder="Trail des Cimes" autoFocus />
            </QuestionShell>
          )}
          {qIndex === 2 && (
            <QuestionShell qIndex={2} total={TOTAL_Q} onCancelAll={cancelSequential} title="C'est quand ?" onNext={next} onBack={back} nextDisabled={!d.date}>
              <input type="date" className={`${inputCls} w-full text-lg py-3`} value={d.date} onChange={e => setD({ ...d, date: e.target.value })} />
            </QuestionShell>
          )}
          {qIndex === 3 && (
            <QuestionShell qIndex={3} total={TOTAL_Q} onCancelAll={cancelSequential}
              title={!D.strategy.usesChocWeekends ? 'Quelle distance ?' : 'Distance et dénivelé ?'}
              subtitle={!D.strategy.usesChocWeekends ? 'Le moteur est calibré pour le marathon — les autres distances restent possibles.' : (D.raceKmEq > 0 ? `≈ ${Math.round(D.raceKmEq)} km-éq · ratio ${Math.round(D.raceRatio)} m D+/km-éq` : null)}
              onNext={next} onBack={back} nextDisabled={!d.distanceKm}>
              {!D.strategy.usesChocWeekends ? (
                <div className="space-y-3">
                  <div className="flex gap-2 flex-wrap">
                    {[{ km: 10, l: '10 km' }, { km: 21.1, l: 'Semi' }, { km: 42.2, l: 'Marathon', best: true }].map(opt => (
                      <button key={opt.km} onClick={() => setD({ ...d, distanceKm: String(opt.km), deniveleM: '' })}
                        className={`px-4 py-3 rounded-lg border text-sm ${String(d.distanceKm) === String(opt.km) ? 'border-emerald-600 bg-emerald-950 text-emerald-300' : 'border-stone-700 text-stone-300 hover:border-stone-500'}`}>
                        {opt.l}{opt.best && <span className="block text-[10px] opacity-70">optimisé</span>}
                      </button>
                    ))}
                  </div>
                  <Field label="Ou une autre distance (km)">
                    <input type="number" inputMode="decimal" className={`${inputCls} w-32 text-lg py-2`} value={d.distanceKm} onChange={e => setD({ ...d, distanceKm: e.target.value })} />
                  </Field>
                </div>
              ) : (
                <div className="flex gap-3">
                  <Field label="Distance (km)"><input type="number" inputMode="decimal" className={`${inputCls} w-full text-lg py-3`} value={d.distanceKm} onChange={e => setD({ ...d, distanceKm: e.target.value })} /></Field>
                  <Field label="D+ (m)"><input type="number" inputMode="decimal" className={`${inputCls} w-full text-lg py-3`} value={d.deniveleM} onChange={e => setD({ ...d, deniveleM: e.target.value })} /></Field>
                </div>
              )}
            </QuestionShell>
          )}
          {qIndex === 4 && (
            <QuestionShell qIndex={4} total={TOTAL_Q} onCancelAll={cancelSequential} title="Comment tu te décrirais comme coureur ?" subtitle="Sert à donner une fourchette de temps de course plus juste, et à calibrer la vitesse de montée en charge." onNext={next} onBack={back} nextDisabled={false}>
              {D.suggestedTier ? (
                <div className="text-xs text-emerald-300 bg-emerald-950 border border-emerald-800 rounded px-3 py-2 mb-3">
                  🎯 Calculé depuis ton historique : <strong>{TIER_LABELS[D.suggestedTier]}</strong>. Bien plus précis qu'un choix à la main — déjà pré-sélectionné ci-dessous, change-le seulement si tu penses qu'il se trompe.
                </div>
              ) : (
                <div className="text-xs text-stone-400 bg-stone-950 border border-stone-800 rounded px-3 py-2 mb-3 flex items-center justify-between gap-3">
                  <span>Pas d'historique renseigné — un historique donne une estimation nettement plus précise qu'un choix à la main.</span>
                  {onGoToProfil && <button onClick={onGoToProfil} className="text-xs font-medium underline shrink-0 text-stone-300">Renseigne-le dans Profil →</button>}
                </div>
              )}
              <div className="space-y-2">
                {[
                  { v: 'standard', l: 'Peu ou pas d\'historique ultra-distance' },
                  { v: 'aguerri', l: 'Bonne base d\'endurance, quelques ultras/longues courses déjà faits' },
                  { v: 'tres_experimente', l: 'Plusieurs ultras dans les jambes, récupération rapide' },
                ].map(opt => (
                  <button key={opt.v} onClick={() => setD({ ...d, experienceTier: opt.v })}
                    className={`w-full text-left px-4 py-3 rounded-lg border relative ${effectiveTier === opt.v ? 'border-emerald-600 bg-emerald-950' : 'border-stone-700 hover:border-stone-500'}`}>
                    <div className="flex items-center gap-2">
                      <span className={effectiveTier === opt.v ? 'text-emerald-300 font-medium' : 'text-stone-200 font-medium'}>{TIER_LABELS[opt.v]}</span>
                      {D.suggestedTier === opt.v && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-800 text-emerald-200">recommandé</span>}
                    </div>
                    <div className="text-xs text-stone-500 mt-0.5">{opt.l}</div>
                  </button>
                ))}
              </div>
            </QuestionShell>
          )}
          {qIndex === 5 && (
            <QuestionShell qIndex={5} total={TOTAL_Q} onCancelAll={cancelSequential} title="Un temps visé, ou un cut-off ?" subtitle={`Facultatif — sinon on l'estime à ${formatDuration(D.raceHoursLow*60)}-${formatDuration(D.raceHoursHigh*60)} (${D.raceHoursSource === 'historique' ? `d'après ton historique` : `palier ${TIER_LABELS[effectiveTier]}`}).`} onNext={next} onBack={back} nextDisabled={false} canSkip onSkip={next}>
              <div className="flex gap-3 flex-wrap">
                {/* Road goals are minutes-and-seconds precise; a decimal number
                    of hours is useless for a marathon target. */}
                <Field label="Temps visé (hh:mm:ss)" hint="ex. 3:29:00">
                  <input type="text" inputMode="numeric" placeholder="3:29:00" className={`${inputCls} w-full text-lg py-3`}
                    value={d.raceTimeStr || ''}
                    onChange={e => {
                      const v = e.target.value;
                      const sec = parseTimeToSeconds(v);
                      setD({ ...d, raceTimeStr: v, raceHoursEstimate: sec ? (sec / 3600) : '' });
                    }} />
                </Field>
                <Field label="Cut-off (h)"><input type="number" inputMode="decimal" className={`${inputCls} w-28 text-lg py-3`} value={d.cutoffH} onChange={e => setD({ ...d, cutoffH: e.target.value })} /></Field>
              </div>
            </QuestionShell>
          )}
          {qIndex === 6 && (
            <QuestionShell qIndex={6} total={TOTAL_Q} onCancelAll={cancelSequential} title="Ton volume hebdomadaire actuel ?"
              subtitle={!D.strategy.usesChocWeekends ? 'En kilomètres — c\'est la référence sur route.' : `≈ ${Math.round(D.startKmEq)} km-éq · ratio ${Math.round(D.startRatio)} m D+/km-éq`}
              onNext={next} onBack={back} nextDisabled={false}>
              {!D.strategy.usesChocWeekends ? (
                <div className="space-y-3">
                  <Field label="Volume actuel (km/sem)">
                    <input type="number" inputMode="decimal" className={`${inputCls} w-40 text-lg py-3`} value={d.startKm} onChange={e => setD({ ...d, startKm: e.target.value })} />
                  </Field>
                  {D.recommendedPeakKmEq > 0 && (
                    <div className="text-xs text-stone-400 bg-stone-950 border border-stone-800 rounded px-3 py-2">
                      <div className="text-stone-200 font-medium mb-1">Pic conseillé : ~{D.recommendedPeakKmEq} km/semaine</div>
                      Calculé depuis ton objectif et ton niveau. Tu l'atteindras sur le dernier tiers de la préparation.
                      Repère : un objectif chronométré sérieux demande d'avoir tenu 50+ km/semaine pendant 2-3 mois avant de commencer.
                      Tu pourras forcer une autre valeur une fois le plan généré.
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex gap-3">
                  <Field label="Volume (km/sem)"><input type="number" inputMode="decimal" className={`${inputCls} w-full text-lg py-3`} value={d.startKm} onChange={e => setD({ ...d, startKm: e.target.value })} /></Field>
                  <Field label="D+ (m/sem)"><input type="number" inputMode="decimal" className={`${inputCls} w-full text-lg py-3`} value={d.startDPlus} onChange={e => setD({ ...d, startDPlus: e.target.value })} /></Field>
                </div>
              )}
            </QuestionShell>
          )}
          {qIndex === 7 && (
            <QuestionShell qIndex={7} total={TOTAL_Q} onCancelAll={cancelSequential} title="Combien d'heures par semaine tu t'entraînes en ce moment ?" subtitle={`≈ ${D.paceMinPerKmEq.toFixed(1)} min/km-éq`} onNext={next} onBack={back} nextDisabled={false}>
              <input type="number" inputMode="decimal" step="0.5" className={`${inputCls} w-full text-lg py-3`} value={d.currentWeeklyHours} onChange={e => setD({ ...d, currentWeeklyHours: e.target.value })} />
            </QuestionShell>
          )}
          {qIndex === 8 && (
            <QuestionShell qIndex={8} total={TOTAL_Q} onCancelAll={cancelSequential} title="Combien de jours par semaine souhaites-tu t’entraîner pendant ta préparation ?" onNext={next} onBack={back} nextDisabled={false}>
              <div className="flex gap-2 flex-wrap">
                {[3, 4, 5, 6, 7].map(n => (
                  <button key={n} onClick={() => setD({ ...d, trainingDaysPerWeek: n })} className={`px-4 py-3 rounded-lg border text-lg ${parseInt(d.trainingDaysPerWeek) === n ? 'border-emerald-600 bg-emerald-950 text-emerald-300' : 'border-stone-700 text-stone-300 hover:border-stone-500'}`}>{n}</button>
                ))}
              </div>
            </QuestionShell>
          )}
          {qIndex === 9 && (
            <QuestionShell qIndex={9} total={TOTAL_Q} onCancelAll={cancelSequential} title="Tes disponibilités en semaine ?" subtitle="Tu travailles : les séances seront dimensionnées pour tenir dans le créneau réel de chaque jour, au lieu de supposer que tu as tout ton temps." onNext={next} onBack={back} nextDisabled={false} canSkip onSkip={next}>
              <div className="space-y-2">
                {DAYS.map(day => {
                  const isWeekend = day.key === 'sam' || day.key === 'dim';
                  const raw = (d.dayAvailability || {})[day.key];
                  const cur = raw == null ? (isWeekend ? ['free'] : ['evening']) : (Array.isArray(raw) ? raw : [raw]);
                  const toggle = (v) => {
                    let nextSlots;
                    if (v === 'none') nextSlots = [];
                    else if (v === 'free') nextSlots = ['free'];
                    else {
                      const base = cur.filter(s => s !== 'free' && s !== 'none');
                      nextSlots = base.includes(v) ? base.filter(s => s !== v) : [...base, v];
                    }
                    setD({ ...d, dayAvailability: { ...(d.dayAvailability || {}), [day.key]: nextSlots } });
                  };
                  return (
                    <div key={day.key} className="flex items-center gap-2">
                      <span className="text-sm text-stone-400 w-20 shrink-0">{day.label}</span>
                      <div className="flex gap-1 flex-wrap">
                        {[{ v: 'none', l: 'Rien' }, { v: 'morning', l: 'Tôt le matin' }, { v: 'midday', l: 'Midi' }, { v: 'evening', l: 'Soir' }, { v: 'free', l: 'Libre' }].map(opt => {
                          const active = opt.v === 'none' ? cur.length === 0 : cur.includes(opt.v);
                          return (
                            <button key={opt.v} onClick={() => toggle(opt.v)}
                              className={`text-xs px-2 py-1.5 rounded border ${active ? 'border-emerald-600 bg-emerald-950 text-emerald-300' : 'border-stone-700 text-stone-400 hover:border-stone-500'}`}>
                              {opt.l}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                {!D.strategy.usesChocWeekends && (
                <label className="flex items-start gap-2 pt-3 mt-2 border-t border-stone-800 cursor-pointer">
                  <input type="checkbox" className="mt-0.5" checked={!!d.fractionneDuJeudi} onChange={e => setD({ ...d, fractionneDuJeudi: e.target.checked })} />
                  <span>
                    <span className="text-sm text-stone-200">Fractionné du jeudi 🏃</span>
                    <span className="block text-[11px] text-stone-500">Séance de groupe fixe le jeudi midi (VMA / fractionné court). Le plan se construit autour au lieu de proposer autre chose.</span>
                  </span>
                </label>
                )}
                <div className="text-[11px] text-stone-500 pt-1">
                  Tu peux cocher <strong>plusieurs créneaux</strong> sur une même journée : c'est souvent indispensable pour encaisser du gros volume en semaine (séance matin + séance soir).
                </div>
              </div>
            </QuestionShell>
          )}
          {qIndex === 10 && !D.strategy.usesChocWeekends && (
            <QuestionShell qIndex={10} total={TOTAL_Q} onCancelAll={cancelSequential} title="Préparation de type route" subtitle="Pas de jauge de spécificité ici : sur cette distance, la performance se joue sur les allures et le travail en zones, pas sur la montée en volume." onNext={next} onBack={back} nextDisabled={false} nextLabel="Voir le temps nécessaire">
              <div className="text-sm text-stone-400">
                Le plan va se concentrer sur une progression régulière du volume et des séances de qualité. Le travail en zones et les allures cibles seront enrichis dans une prochaine version.
              </div>
            </QuestionShell>
          )}
          {qIndex === 10 && D.strategy.usesChocWeekends && (
            <QuestionShell qIndex={10} total={TOTAL_Q} onCancelAll={cancelSequential} title="Prêt à faire du volume ?" subtitle="Valeur par défaut : 75% (intermédiaire) — ça convient pour un objectif « juste finir ». Ajuste seulement si tu vises un chrono précis (plus haut) ou préfères jouer la sécurité (plus bas)." onNext={next} onBack={back} nextDisabled={false} nextLabel="Voir le temps nécessaire">
              <input type="range" min="0.5" max="1" step="0.05" className="w-full" value={d.specificity} onChange={e => setD({ ...d, specificity: e.target.value })} />
              <div className="text-center text-2xl font-medium text-emerald-400 mt-2">{Math.round(parsed.specificity * 100)} %</div>
              <div className="text-xs text-stone-500 text-center mt-1">de la durée de course visée sur le dernier week-end choc</div>
              <div className="text-[11px] text-stone-600 mt-4 leading-relaxed">
                <div><strong>~55-60 % (prudent)</strong> : entraîne la capacité à encaisser la durée, sans viser un chrono précis.</div>
                <div className="mt-1"><strong>~65-75 % (intermédiaire, le défaut)</strong> : bon compromis répétition/risque pour un objectif "juste finir".</div>
                <div className="mt-1"><strong>~90-100 % (agressif)</strong> : nécessaire pour viser un temps précis — sans répéter l'intégralité de l'effort avant le jour J, un objectif chronométré n'a pas vraiment de sens.</div>
              </div>
            </QuestionShell>
          )}
          {qIndex === 11 && (
            <QuestionShell qIndex={11} total={TOTAL_Q} onCancelAll={cancelSequential} title="Voici le temps de prépa nécessaire" subtitle="Ça règle la vitesse de montée en charge (et le temps de course estimé si tu n'as pas d'historique)." onNext={finishSequential} onBack={back} nextDisabled={false} nextLabel="Terminé →">
              {D.suggestedTier ? (
                <div className="text-xs text-emerald-300 bg-emerald-950 border border-emerald-800 rounded px-3 py-2 mb-3">
                  🎯 Déjà sélectionné d'après ton historique : <strong>{TIER_LABELS[D.suggestedTier]}</strong>. Change seulement si tu penses qu'il se trompe.
                </div>
              ) : (
                <div className="text-xs text-stone-400 bg-stone-950 border border-stone-800 rounded px-3 py-2 mb-3 flex items-center justify-between gap-3">
                  <span>Pas d'historique — ce choix serait calculé automatiquement si tu en avais un.</span>
                  {onGoToProfil && <button onClick={onGoToProfil} className="text-xs font-medium underline shrink-0 text-stone-300">Renseigne-le dans Profil →</button>}
                </div>
              )}
              {tierComparison ? (
                <div className="space-y-2">
                  {tierComparison.map(tc => (
                    <button key={tc.tier} onClick={() => setD({ ...d, experienceTier: tc.tier })}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border ${tc.tier === effectiveTier ? 'border-emerald-600 bg-emerald-950' : tc.fits ? 'border-stone-700 hover:border-stone-500' : 'border-stone-800'}`}>
                      <span className={tc.tier === effectiveTier ? 'text-emerald-300' : tc.fits ? 'text-stone-200' : 'text-stone-500'}>{TIER_LABELS[tc.tier]}</span>
                      <span className={tc.tier === effectiveTier ? 'text-emerald-300' : tc.fits ? 'text-stone-300' : 'text-stone-600'}>{tc.weeks} semaines {tc.fits ? '✓' : ''}</span>
                    </button>
                  ))}
                  {idealStart && (
                    <div className={`text-xs mt-2 ${idealStart.slackWeeks > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>
                      {idealStart.slackWeeks > 0 ? `Avec le palier ${TIER_LABELS[effectiveTier]}, il aurait fallu démarrer ${idealStart.slackWeeks} semaine(s) plus tôt.` : idealStart.slackWeeks < 0 ? `Tu as ${-idealStart.slackWeeks} semaine(s) de marge avec ce palier.` : 'Pile dans les temps avec ce palier.'}
                    </div>
                  )}
                  {effectiveTier !== 'standard' && (!D.suggestedTier || TIER_LABELS[effectiveTier] !== TIER_LABELS[D.suggestedTier]) && (
                    <div className="text-xs text-amber-300 bg-amber-950 border border-amber-800 rounded px-3 py-2 mt-2">
                      ⚠️ Un palier plus rapide que ce que ton historique justifie augmente le risque de blessure si tu surestimes ta capacité à encaisser la charge.
                    </div>
                  )}
                  {idealStart && idealStart.canWait && (
                    <div className="mt-3 pt-3 border-t border-stone-800">
                      <div className="text-sm text-stone-300 mb-1">Tu as {-idealStart.slackWeeks} semaine(s) de marge — quand commencer ?</div>
                      <div className="text-[11px] text-stone-500 mb-2">
                        Commencer tout de suite ne sert pas à s'entraîner plus longtemps pour rien : les semaines gagnées s'ajoutent au sommet de la prépa. Tu passes plus de temps au volume de pic, et si la marge est suffisante, l'appli peut caser un <strong>PIC CHOC de transition</strong> supplémentaire — donc tu arrives mieux préparé le jour J.
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <button onClick={() => setD({ ...d, planStartDate: '' })}
                          className={`flex-1 text-left px-3 py-2.5 rounded-lg border ${!d.planStartDate ? 'border-emerald-600 bg-emerald-950' : 'border-stone-700 hover:border-stone-500'}`}>
                          <div className={`text-sm font-medium ${!d.planStartDate ? 'text-emerald-300' : 'text-stone-200'}`}>Commencer maintenant</div>
                          <div className="text-[11px] text-stone-500 mt-0.5">Plus de semaines au volume de pic</div>
                        </button>
                        <button onClick={() => setD({ ...d, planStartDate: idealStart.date.toISOString().slice(0, 10) })}
                          className={`flex-1 text-left px-3 py-2.5 rounded-lg border ${d.planStartDate ? 'border-emerald-600 bg-emerald-950' : 'border-stone-700 hover:border-stone-500'}`}>
                          <div className={`text-sm font-medium ${d.planStartDate ? 'text-emerald-300' : 'text-stone-200'}`}>Attendre le {fmtShort(idealStart.date)}</div>
                          <div className="text-[11px] text-stone-500 mt-0.5">Prépa au plus juste, sans surcharge</div>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : <div className="text-sm text-stone-500">Renseigne une date et une distance valides pour voir cette estimation.</div>}
            </QuestionShell>
          )}
        </>
      )}

      {fillMode === 'flat' && (
      <>
      {planInfo.length > 0 && (
        <div className="text-xs bg-stone-900 border rounded px-3 py-2 space-y-2" style={{ borderColor: PHASE_COLORS.picchoc.bar + '66', color: PHASE_COLORS.picchoc.text }}>
          {planInfo.map((p, i) => (
            <div key={i}>
              <div className="font-medium flex items-center gap-1.5"><Flame size={13} />{p.title}</div>
              <div className="mt-0.5 text-stone-300">{p.text}</div>
              {p.paces && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 mt-2">
                  {Object.keys(p.paces).map(k => (
                    <div key={k} className="bg-stone-950 rounded p-1.5 text-center">
                      <div className="text-stone-200 font-medium">{fmtPace(p.paces[k].secPerKm)}</div>
                      <div className="text-[10px] text-stone-500 truncate">{p.paces[k].label}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(warnings.length > 0 || missingTypes.length > 0) && (
        <div className="text-xs text-amber-200 bg-amber-950 border border-amber-800 rounded px-3 py-2 space-y-2">
          {warnings.map((w, i) => (
            <div key={i}><div className="font-medium">{w.title}</div><div>{w.text}</div></div>
          ))}
          {missingTypes.length > 0 && (
            <div><div className="font-medium">Bibliothèque incomplète</div><div>Pas de séance de type : {missingTypes.join(', ')}. Le générateur mettra de l'EF à la place.</div></div>
          )}
        </div>
      )}

      {!D.strategy.usesChocWeekends && D.roadPaces && (
        <div className="border border-stone-800 rounded-lg bg-stone-900 p-3">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <span className="text-sm font-medium text-stone-300">Tes allures</span>
            {(() => {
              const nextBm = preview.find(w => w.weeksBeforeRace > 0 && BENCHMARK_SCHEDULE_BY_DISTANCE[roadDistanceKey(parsed.distanceKm)].some(s => s.weeksBefore === w.weeksBeforeRace));
              if (!nextBm) return null;
              const bm = benchmarkFor(nextBm.weeksBeforeRace, parsed.distanceKm, D.roadPaces);
              const days = Math.max(0, Math.round((nextBm.monday - new Date()) / 86400000));
              return (
                <span className="text-xs text-amber-300 flex items-center gap-1.5">
                  <Target size={13} />
                  {bm.label} dans {days} j — {bm.description}
                </span>
              );
            })()}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
            {Object.keys(D.roadPaces).map(k => (
              <div key={k} className="bg-stone-950 rounded p-2 text-center">
                <div className="text-stone-100 font-medium text-sm">{fmtPace(D.roadPaces[k].secPerKm)}</div>
                <div className="text-[10px] text-stone-500 truncate">{D.roadPaces[k].label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <PlanResults
        preview={preview} chocWeeks={chocWeeks} picChocBlock={picChocBlock} D={D}
        selectedWeekKey={selectedWeekKey} setSelectedWeekKey={setSelectedWeekKey}
        confirming={confirming} setConfirming={setConfirming} doGenerate={doGenerate}
        showDetail={showDetail} setShowDetail={setShowDetail}
        onExtendWeekend={(wk, days) => setD({ ...d, chocDayOverrides: { ...(d.chocDayOverrides || {}), [wk]: days } })}
      />

      <details className="border border-stone-800 rounded-lg bg-stone-900 group">
        <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-stone-300 flex items-center gap-2 select-none">
          <ChevronDown size={15} className="transition-transform group-open:rotate-180" />
          Détails de l'objectif — modifier les paramètres
        </summary>
        <div className="p-4 pt-0 space-y-4">
        <div>
          <div className="text-sm font-medium text-stone-300 mb-2">La course</div>
          <div className="flex flex-wrap gap-2">
            <div className="flex-1 min-w-[160px]"><Field label="Nom de la course"><input className={`${inputCls} w-full`} value={d.nom} onChange={e => setD({ ...d, nom: e.target.value })} /></Field></div>
            <Field label="Date de l'événement"><input type="date" className={inputCls} value={d.date} onChange={e => setD({ ...d, date: e.target.value })} /></Field>
            <Field label="Distance (km)"><input type="number" inputMode="decimal" className={`${inputCls} w-24`} value={d.distanceKm} onChange={e => setD({ ...d, distanceKm: e.target.value })} /></Field>
            <Field label="D+ (m)"><input type="number" inputMode="decimal" className={`${inputCls} w-24`} value={d.deniveleM} onChange={e => setD({ ...d, deniveleM: e.target.value })} /></Field>
            <Field label="Temps visé (h)" hint={raceTimeHint}>
              <input type="number" inputMode="decimal" step="0.5" className={`${inputCls} w-24`} value={d.raceHoursEstimate} onChange={e => setD({ ...d, raceHoursEstimate: e.target.value })} /></Field>
            <Field label="Cut-off (h)"><input type="number" inputMode="decimal" className={`${inputCls} w-20`} value={d.cutoffH} onChange={e => setD({ ...d, cutoffH: e.target.value })} /></Field>
          </div>
          {D.raceKmEq > 0 && <div className="text-xs text-stone-500 mt-2">≈ {Math.round(D.raceKmEq)} km-éq · ratio de spécificité {Math.round(D.raceRatio)} m D+/km-éq</div>}
          {profileRef && !d.raceHoursEstimate && (
            <div className="text-[11px] text-stone-600 mt-1">Temps estimé depuis ta performance de référence (onglet Profil) via extrapolation de Riegel + correction fatigue ultra — fourchette large, pas une promesse.</div>
          )}
        </div>

        <div>
          <div className="text-sm font-medium text-stone-300 mb-2">Ton point de départ</div>
          <div className="flex flex-wrap gap-2">
            <Field label="Volume de départ souhaité (km/sem)"><input type="number" inputMode="decimal" className={`${inputCls} w-24`} value={d.startKm} onChange={e => setD({ ...d, startKm: e.target.value })} /></Field>
            <Field label="D+ de départ (m/sem)"><input type="number" inputMode="decimal" className={`${inputCls} w-24`} value={d.startDPlus} onChange={e => setD({ ...d, startDPlus: e.target.value })} /></Field>
            <Field label="Temps hebdo actuel (h)" hint={`≈ ${D.paceMinPerKmEq.toFixed(1)} min/km-éq`}><input type="number" inputMode="decimal" step="0.5" className={`${inputCls} w-20`} value={d.currentWeeklyHours} onChange={e => setD({ ...d, currentWeeklyHours: e.target.value })} /></Field>
            <Field label="Volume réel 4 dern. sem. (km, optionnel)"><input type="number" inputMode="decimal" className={`${inputCls} w-24`} value={d.habitualKm} onChange={e => setD({ ...d, habitualKm: e.target.value })} /></Field>
            <Field label="D+ réel 4 dern. sem. (m, optionnel)"><input type="number" inputMode="decimal" className={`${inputCls} w-24`} value={d.habitualDPlus} onChange={e => setD({ ...d, habitualDPlus: e.target.value })} /></Field>
          </div>
          <div className="text-xs text-stone-500 mt-2">≈ {Math.round(D.startKmEq)} km-éq de départ · ratio {Math.round(D.startRatio)} m D+/km-éq</div>
        </div>

        <div>
          <div className="text-sm font-medium text-stone-300 mb-2">Le plan</div>
          <div className="flex flex-wrap gap-2">
            <Field label="Jours souhaités pendant la préparation"><input type="number" inputMode="decimal" min="2" max="7" className={`${inputCls} w-20`} value={d.trainingDaysPerWeek} onChange={e => setD({ ...d, trainingDaysPerWeek: e.target.value })} /></Field>
            <Field label="Semaines d'affûtage"><input type="number" inputMode="decimal" min="0" max="4" className={`${inputCls} w-20`} value={d.taperWeeks} onChange={e => setD({ ...d, taperWeeks: e.target.value })} /></Field>
            <Field label="Pic visé (km-éq/sem)" hint={`conseillé ~${D.recommendedPeakKmEq}${D.raceKmEq ? ` (${Math.round((D.recommendedPeakKmEq / D.raceKmEq) * 100)} % du volume de la course)` : ''}`}><input type="number" inputMode="decimal" className={`${inputCls} w-24`} value={d.peakKmEq} onChange={e => setD({ ...d, peakKmEq: e.target.value })} placeholder={String(D.recommendedPeakKmEq)} /></Field>
          </div>
          {parsed.peakKmEq > 0 && D.raceKmEq > 0 && (
            <div className="text-xs text-stone-500 mt-1">Ton pic actuel représente {Math.round((parsed.peakKmEq / D.raceKmEq) * 100)} % du volume de la course.</div>
          )}
          {idealStart && (
            <div className={`text-xs mt-2 ${idealStart.slackWeeks > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>
              Date de départ idéale : <strong>{fmtShort(idealStart.date)}</strong> ({idealStart.weeksNeeded} semaines avant la course)
              {idealStart.slackWeeks > 0 ? ` — il aurait fallu démarrer ${idealStart.slackWeeks} semaine(s) plus tôt` : idealStart.slackWeeks < 0 ? ` — tu as ${-idealStart.slackWeeks} semaine(s) de marge` : ' — pile dans les temps'}
            </div>
          )}
          {idealStart && idealStart.canWait && (
            <div className="mt-2 text-xs">
              <div className="text-stone-500 mb-1.5">Tu as {-idealStart.slackWeeks} semaine(s) de marge — quand veux-tu commencer ?</div>
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => setD({ ...d, planStartDate: '' })}
                  className={`px-2.5 py-1.5 rounded border text-xs text-left ${!d.planStartDate ? 'border-emerald-700 bg-emerald-950 text-emerald-300' : 'border-stone-700 text-stone-300 hover:border-stone-500'}`}>
                  <div className="font-medium">Commencer maintenant</div>
                  <div className="opacity-70">arriver plus haut en volume le jour J</div>
                </button>
                <button onClick={() => setD({ ...d, planStartDate: idealStart.date.toISOString().slice(0, 10) })}
                  className={`px-2.5 py-1.5 rounded border text-xs text-left ${d.planStartDate ? 'border-emerald-700 bg-emerald-950 text-emerald-300' : 'border-stone-700 text-stone-300 hover:border-stone-500'}`}>
                  <div className="font-medium">Attendre le {fmtShort(idealStart.date)}</div>
                  <div className="opacity-70">prépa au plus juste, sans surcharge</div>
                </button>
              </div>
            </div>
          )}
          {tierComparison && (
            <div className="mt-2 text-xs text-stone-500">
              <div className="mb-1">Temps de prépa selon le palier — clique pour changer. Si tu veux être 100% tranquille, vise le plus prudent ; si le temps manque, un palier plus rapide peut suffire :</div>
              <div className="flex flex-wrap gap-2">
                {tierComparison.map(tc => (
                  <button key={tc.tier} onClick={() => setD({ ...d, experienceTier: tc.tier })}
                    className={`px-2 py-1 rounded border text-xs transition-colors ${tc.tier === effectiveTier ? 'border-emerald-700 bg-emerald-950 text-emerald-300' : tc.fits ? 'border-stone-700 text-stone-300 hover:border-stone-500' : 'border-stone-800 text-stone-600 hover:border-stone-600'}`}>
                    {TIER_LABELS[tc.tier]} : {tc.weeks} sem {tc.fits ? '✓' : ''}
                  </button>
                ))}
              </div>
              {d.experienceTier && <button onClick={() => setD({ ...d, experienceTier: null })} className="text-[11px] text-stone-600 hover:text-stone-400 underline mt-1">revenir à la suggestion automatique</button>}
              {effectiveTier !== 'standard' && (!D.suggestedTier || effectiveTier !== D.suggestedTier) && (
                <div className="text-xs text-amber-300 bg-amber-950 border border-amber-800 rounded px-3 py-2 mt-2">
                  ⚠️ Un palier plus rapide que ce que ton historique justifie augmente le risque de blessure si tu surestimes ta capacité à encaisser la charge.
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <div className="text-sm font-medium text-stone-300 mb-2">Prêt à faire du volume ?</div>
          <div className="flex flex-wrap gap-2 items-end">
            <Field label="Niveau de spécificité" hint={`${Math.round(parsed.specificity * 100)} % de la durée de course`}>
              <input type="range" min="0.5" max="1" step="0.05" className="w-40" value={d.specificity} onChange={e => setD({ ...d, specificity: e.target.value })} />
            </Field>
          </div>
          <div className="text-[11px] text-stone-500 mt-1 italic">
            Ce curseur règle à quel point tu es prêt à absorber du volume sur toute la préparation — pas juste le dernier week-end. Ça détermine le pic hebdomadaire nécessaire (donc la durée de la prépa) ET le volume des week-ends choc. Le % affiché est juste le repère le plus concret : la part de la durée de course qu'un week-end choc doit couvrir.
          </div>
          <div className="text-[11px] text-stone-600 mt-1.5 leading-relaxed">
            <div><strong>~55-60 % (prudent)</strong> : entraîne la capacité à encaisser la durée, sans viser un chrono précis.</div>
            <div className="mt-1"><strong>~65-75 % (intermédiaire, le défaut)</strong> : bon compromis répétition/risque pour un objectif "juste finir".</div>
            <div className="mt-1"><strong>~90-100 % (agressif)</strong> : nécessaire pour viser un temps précis — sans répéter l'intégralité de l'effort avant le jour J, un objectif chronométré n'a pas vraiment de sens.</div>
          </div>
          {picChocNote && <div className="text-[11px] text-orange-400 mt-1.5">{picChocNote}</div>}
          {lastChoc && lastChoc.weekend && (
            <div className="text-sm text-stone-300 mt-2 bg-stone-950 border border-stone-800 rounded px-3 py-2">
              Dernier week-end choc : <strong>{formatDuration(lastChoc.weekend.hours*60)}</strong> sur {lastChoc.weekend.days} jour{lastChoc.weekend.days > 1 ? 's' : ''} (choisi automatiquement)
              {lastChoc.weekend.pctOfRace != null ? <> — <strong>{lastChoc.weekend.pctOfRace} %</strong> de la durée de course</> : ''}
              <span className="text-stone-500"> ({lastChoc.weekend.perDayHours.map(h=>formatDuration(h*60)).join(' + ')} par jour)</span>
            </div>
          )}
          <div className="text-[11px] text-stone-600 mt-1">
            À format identique (2 ou 3 jours), le total d'heures ne dit pas tout : réparti sur 3 jours plutôt que 2, chaque journée est plus courte pour le même cumul — la fatigue par journée n'est pas la même.
          </div>
        </div>
        </div>
      </details>

      {d.date && preview.length === 0 && <p className="text-sm text-red-400">Date invalide ou déjà passée.</p>}
      </>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('objectif');
  const [library, setLibrary] = useState([...ULTRA_LIBRARY, ...ROAD_LIBRARY]);
  const [monday, setMonday] = useState(() => getMonday(new Date()));
  const [allPlans, setAllPlansState] = useState({});
  const [weekMeta, setWeekMetaState] = useState({});
  const [focusSessionId, setFocusSessionId] = useState(null);
  const [generatedSessions, setGeneratedSessionsState] = useState({});
  const [benchmarkResults, setBenchmarkResultsState] = useState({}); // { [weekKey]: weekPlan } — one storage key for every week, not one key per week
  const [profile, setProfileState] = useState({});
  const [objectif, setObjectifState] = useState({});
  const [ready, setReady] = useState(false);

  // initial load
  useEffect(() => {
    (async () => {
      const libVersion = await storageGet('library-version', 0);
      const lib = libVersion >= 6 ? await storageGet('seance-library', null) : null;
      if (libVersion < 6) { storageSet('library-version', 6); storageSet('seance-library', [...ULTRA_LIBRARY, ...ROAD_LIBRARY]); }
      if (lib && Array.isArray(lib) && lib.length) setLibrary(lib);
      const prof = await storageGet('training-profile', null);
      if (prof) setProfileState(prof);
      const obj = await storageGet('race-objectif', null);
      if (obj) setObjectifState(obj);
      const plans = await storageGet('all-week-plans', null);
      if (plans) setAllPlansState(plans);
      const meta = await storageGet('week-meta', null);
      if (meta) setWeekMetaState(meta);
      const gen = await storageGet('generated-sessions', null);
      if (gen) setGeneratedSessionsState(gen);
      const br = await storageGet('benchmark-results', null);
      if (br) setBenchmarkResultsState(br);
      setReady(true);
    })();
  }, []);

  const setProfile = (p) => { setProfileState(p); storageSet('training-profile', p); };

  // A generated plan can span dozens of weeks — writing them as separate
  // storage keys fired every week's save without awaiting the previous one,
  // which silently hit the storage rate limit and dropped most weeks beyond
  // the first. One consolidated key, one write, no race.
  const generatePlan = (objectifData, weeks) => {
    setObjectifState(objectifData);
    storageSet('race-objectif', { ...objectifData, historySignature: (objectifData.history || []).length });
    // Doubles are decided once, against the hardest week of the plan.
    const peakHours = weeks.reduce((m, w) => Math.max(m, w.targetHours || 0), 0);
    const doubleSession = determineDoubleSessionNeed(peakHours, objectifData.dayAvailability);
    const derived = deriveObjectif(objectifData);
    const genObjectif = { ...objectifData, doubleSession,
      roadPaces: derived.roadPaces, effectiveDiscipline: derived.effectiveDiscipline };
    setAllPlansState(prev => {
      const next = { ...prev };
      const genSessions = {};
      weeks.forEach((w, idx) => {
        // Progression index advances through the specific block so marathon-pace
        // and threshold work get harder as race day approaches.
        const specIdx = weeks.slice(0, idx).filter(x => x.macrocycle === 'specifique').length;
        const a = buildWeekAssignments(w.phase, objectifData.trainingDaysPerWeek || 5, library, idx, w.weekend || null, w,
          { ...genObjectif, progressIdx: specIdx });
        (a.__meta.generated || []).forEach(g => { genSessions[g.id] = g; });
        delete a.__meta.generated;
        next[w.weekKey] = a;
      });
      setGeneratedSessionsState(genSessions);
      storageSet('generated-sessions', genSessions);
      storageSet('all-week-plans', next);
      buildMeta(next);
      return next;
    });
    // Week metadata kept separately so the Semaine tab can show how the week
    // was built without re-deriving the whole plan.
    function buildMeta(next) {
    const meta = {};
    weeks.forEach(w => {
      const am = (next[w.weekKey] && next[w.weekKey].__meta) || {};
      meta[w.weekKey] = { phase: w.phase, macrocycle: w.macrocycle, note: w.note || null, atPeak: !!w.atPeak,
        targetVolumeKm: w.targetVolumeKm, targetDPlus: w.targetDPlus, targetHours: w.targetHours,
        targetKmEq: w.targetKmEq, weeksBeforeRace: w.weeksBeforeRace,
        actualHours: am.actualHours, weekendPct: am.weekendPct, doubleUsed: am.doubleUsed,
        benchmark: am.benchmark || null, capacityExceeded: am.capacityExceeded };
    });
    setWeekMetaState(meta);
    storageSet('week-meta', meta);
    }
  };

  const weekPlan = allPlans[weekKey(monday)] || emptyWeekPlan();
  const setWeekPlan = (updater) => {
    const key = weekKey(monday);
    setAllPlansState(prev => {
      const current = prev[key] || emptyWeekPlan();
      const nextWeek = typeof updater === 'function' ? updater(current) : updater;
      const next = { ...prev, [key]: nextWeek };
      storageSet('all-week-plans', next);
      return next;
    });
  };

  useEffect(() => { if (ready) storageSet('seance-library', library); }, [library, ready]);

  const tabs = [
    { key: 'objectif', label: 'Objectif', icon: Target },
    { key: 'planning', label: 'Semaine', icon: Calendar },
    { key: 'library', label: 'Séances', icon: BookOpen },
    { key: 'profil', label: 'Profil', icon: User },
    { key: 'assistant', label: 'Assistant', icon: MessageCircle },
  ];

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100 pb-20" style={{ colorScheme: 'dark' }}>
      <style>{`
        /* Native controls follow the OS light theme by default, which is why
           the date-picker icon, select arrows and range thumb were nearly
           invisible on the dark background. colorScheme above fixes most of
           it; these make the calendar icon explicit and comfortably tappable. */
        input[type="date"]::-webkit-calendar-picker-indicator {
          filter: invert(1); opacity: 0.75; cursor: pointer; padding: 4px;
        }
        input[type="date"]::-webkit-calendar-picker-indicator:hover { opacity: 1; }
        input[type="range"] { accent-color: #059669; }
        input, select, textarea { color-scheme: dark; }
      `}</style>
      <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-4 lg:pl-52 lg:max-w-[1400px]">
        <h1 className="text-xl font-semibold text-stone-100 lg:hidden flex items-center gap-2">
          <Mountain size={20} className="text-emerald-500" />
          GOAT <span className="text-emerald-500">Trail</span>
        </h1>

        {!ready ? (
          <div className="text-sm text-stone-500 py-10 text-center">Chargement…</div>
        ) : (
          <>
            {tab === 'objectif' && <ObjectifTab objectif={objectif} onGenerate={generatePlan} library={library} profile={profile} onGoToProfil={() => setTab('profil')} />}
            {tab === 'planning' && (
              <PlanningTab library={[...library, ...Object.values(generatedSessions)]} monday={monday} setMonday={setMonday} weekPlan={weekPlan} setWeekPlan={setWeekPlan} meta={weekMeta[weekKey(monday)] || null} onOpenSession={(id) => { setFocusSessionId(id); setTab('library'); }}
              benchmarkResults={weekMeta[weekKey(monday)] ? benchmarkResults : {}}
              onBenchmarkResult={(wk, result) => {
                setBenchmarkResultsState(prev => {
                  const next = { ...prev, [wk]: result };
                  storageSet('benchmark-results', next);
                  return next;
                });
              }} />
            )}
            {tab === 'library' && <LibraryTab library={library} setLibrary={setLibrary} focusId={focusSessionId} clearFocus={() => setFocusSessionId(null)} />}
            {tab === 'profil' && <ProfilTab profile={profile} setProfile={setProfile} library={library} setLibrary={setLibrary} />}
            {tab === 'assistant' && (
              <AssistantTab library={library} monday={monday} weekPlan={weekPlan} setWeekPlan={setWeekPlan} />
            )}
          </>
        )}
      </div>

      {/* Mobile: bottom bar (thumb-reachable). Desktop: a left rail, which
          reads better with a mouse and frees vertical space. Same component,
          same state — just a different shape per viewport. */}
      <nav className="fixed bottom-0 left-0 right-0 bg-stone-900 border-t border-stone-800 flex justify-around py-1.5 z-10 lg:hidden">
        {tabs.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} className="flex flex-col items-center gap-0.5 px-3 py-2 min-w-[64px] min-h-[44px]">
              <Icon size={20} className={active ? 'text-emerald-400' : 'text-stone-600'} />
              <span className={`text-[11px] ${active ? 'text-emerald-400 font-medium' : 'text-stone-600'}`}>{t.label}</span>
            </button>
          );
        })}
      </nav>
      <nav className="hidden lg:flex fixed top-0 left-0 bottom-0 w-48 bg-stone-900 border-r border-stone-800 flex-col gap-1 p-3 z-10">
        <div className="flex items-center gap-2 px-2 py-3">
          <Mountain size={18} className="text-emerald-500" />
          <span className="text-base font-semibold text-stone-100">GOAT <span className="text-emerald-500">Trail</span></span>
        </div>
        {tabs.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors ${active ? 'bg-emerald-950 text-emerald-300' : 'text-stone-400 hover:bg-stone-800'}`}>
              <Icon size={18} />{t.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
