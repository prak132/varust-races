// The lobby before a race: one gilded card over the drifting, frosted track. It lists the
// drivers (with their cars and whether they're ready), the race settings, and Leave and Ready.
// Once everyone is ready the red start flag waves and the race takes over. Online, everyone
// comes back here after each race, and the host picks the next track.
import type { Screen } from '../app';
import * as audio from '../audio';
import { button, h } from '../dom';
import { allMaps, mapById } from '../game/backdrops';
import { OnlineSource } from '../game/online';
import { RaceStage } from '../game/race';
import { leaveRoom, online } from '../game/rooms';
import { LocalSource } from '../game/session';
import { carSprite, cpuSprite } from '../assets';
import { net } from '../net';
import { nav } from '../nav';
import { pref } from '../prefs';
import type { LobbyPlayer, MapDef, ServerMsg, Settings } from '../wasm';
import { card, cardTitle, carIcon, centered, kicker, picker, pill, row, smallButton } from './cards';

const LAP_CHOICES = [1, 2, 3, 5];
const DIFFICULTIES = ['EASY', 'NORMAL', 'HARD'];
const CPUS = 3;

/** the lobby's card; the local and online lobbies fill it in */
abstract class LobbyCard implements Screen {
  readonly el: HTMLElement;
  protected readonly map: MapDef;
  protected readonly kickerEl: HTMLElement;
  protected readonly drivers = h('div');
  protected readonly note = h('div.note');
  protected readonly ready: HTMLButtonElement;
  private readonly track = picker('TRACK', (d) => this.stepTrack(d));
  private readonly laps = picker('LAPS', (d) => this.stepLaps(d));
  private readonly cpus = picker('CPU CARS', () => this.changeSettings({ ...this.settings, cpus: !this.settings.cpus }));
  private readonly difficulty = picker('CPU DIFFICULTY', (d) => this.stepDifficulty(d));
  protected settings: Settings = { laps: 1, difficulty: 1, cpus: true };

  constructor(mapId: string, kickerText: string, title: string, showSettings: boolean, pickTrack = false) {
    audio.playMusic('music_title');
    this.map = mapById(mapId);
    this.kickerEl = kicker(kickerText);
    this.ready = button('Ready', () => this.onReady());
    this.el = centered(card(
      this.kickerEl,
      cardTitle(title),
      kicker('DRIVERS'),
      this.drivers,
      showSettings && kicker('RACE SETTINGS'),
      showSettings && pickTrack && this.track.el,
      showSettings && this.map.kind === 'circuit' && this.laps.el,
      showSettings && this.cpus.el,
      showSettings && this.difficulty.el,
      this.note,
      h('div.card-buttons', null, smallButton('Leave', () => this.onLeave()), h('div.spacer'), this.ready),
    ));
    this.showSettings(false);
  }

  protected abstract onReady(): void;
  protected abstract onLeave(): void;
  protected abstract changeSettings(settings: Settings): void;
  /** online: the host asks for another track */
  protected changeTrack(_mapId: string): void {}

  private stepTrack(d: number): void {
    const maps = allMaps();
    const i = maps.findIndex((m) => m.id === this.map.id);
    this.changeTrack(maps[(i + d + maps.length) % maps.length].id);
  }

  private stepLaps(d: number): void {
    const i = Math.max(0, LAP_CHOICES.indexOf(this.settings.laps));
    this.changeSettings({ ...this.settings, laps: LAP_CHOICES[(i + d + LAP_CHOICES.length) % LAP_CHOICES.length] });
  }

  private stepDifficulty(d: number): void {
    this.changeSettings({ ...this.settings, difficulty: (this.settings.difficulty + d + 3) % 3 });
  }

  /** shows the settings, with the arrows only for whoever can change them */
  protected showSettings(canChange: boolean): void {
    const { laps, difficulty, cpus } = this.settings;
    this.track.value.textContent = this.map.name.toUpperCase();
    this.laps.value.textContent = `${laps} ${laps === 1 ? 'LAP' : 'LAPS'}`;
    this.cpus.value.textContent = cpus ? 'ON' : 'OFF';
    this.difficulty.el.style.display = cpus ? '' : 'none';
    this.difficulty.value.textContent = DIFFICULTIES[difficulty] ?? 'NORMAL';
    this.difficulty.value.style.color = difficulty === 0 ? '#45a852' : difficulty === 2 ? '#ff8066' : '';
    for (const b of [...this.track.arrows, ...this.laps.arrows, ...this.cpus.arrows, ...this.difficulty.arrows]) {
      b.style.visibility = canChange ? '' : 'hidden';
    }
  }

  protected driverRow(sprite: string, name: string, you: boolean, status: 'READY' | 'NOT READY' | 'CPU' | 'RACING' | 'WAITING'): HTMLElement {
    return row(
      carIcon(sprite),
      h(you ? 'span.grow.gold' : 'span.grow', null, name),
      status === 'CPU' ? pill(this.map.cpu_name, 'cpu') : pill(status, status === 'READY' ? 'ready' : ''),
    );
  }
}

/** single player: the race runs here, against three CPUs */
export class LocalLobbyScreen extends LobbyCard {
  private starting = false;

  constructor(mapId: string) {
    super(mapId, 'SINGLE PLAYER', mapById(mapId).name.toUpperCase(), true);
    this.render();
  }

  private render(): void {
    const car = pref('car');
    this.drivers.replaceChildren(
      this.driverRow(carSprite(car), 'YOU', true, this.starting ? 'READY' : 'NOT READY'),
      ...Array.from({ length: this.settings.cpus ? CPUS : 0 }, (_, i) => this.driverRow(cpuSprite(this.map.cpu_sprite, i), `${this.map.cpu_name} ${i + 1}`, false, 'CPU')),
    );
    this.showSettings(!this.starting);
  }

  protected changeSettings(settings: Settings): void {
    this.settings = settings;
    this.render();
  }

  protected onReady(): void {
    if (this.starting) return;
    this.starting = true;
    audio.play('ready', 0.5);
    this.ready.disabled = true;
    this.render();
    void RaceStage.open(new LocalSource(this.map, pref('car'), this.settings));
  }

  protected onLeave(): void {
    if (!this.starting) void nav.menu();
  }
}

/** online: the room's players, the host's track and settings, and (ranked) the queue */
export class OnlineLobbyScreen extends LobbyCard {
  private readonly stop: () => void;
  private readonly stopClose: () => void;
  private readyPressed = false;
  private starting = false;
  private moving = false;

  constructor(mapId: string) {
    const room = online.room!;
    const ranked = room.visibility === 'Ranked';
    const map = mapById(mapId);
    const kickerText = ranked
      ? `RANKED  /  ${map.name.toUpperCase()}`
      : `${room.visibility === 'Public' ? 'PUBLIC LOBBY' : 'PRIVATE LOBBY'}  /  ${map.name.toUpperCase()}`;
    super(mapId, kickerText, ranked ? 'RANKED RACE' : room.code, !ranked, true);
    this.stop = net.on((msg) => this.message(msg));
    this.stopClose = net.onClose(() => {
      this.kickerEl.textContent = (net.error ?? 'Lost connection').toUpperCase();
      this.kickerEl.classList.add('error');
      this.ready.disabled = true;
    });
    this.render();
  }

  private message(msg: ServerMsg): void {
    if (typeof msg === 'object' && 'Race' in msg && !this.starting) {
      // everyone's ready: the race begins (its first message carries the flag)
      this.starting = true;
      const room = online.room!;
      const source = new OnlineSource(this.map, room.slot, online.lobby?.players ?? [], msg);
      void RaceStage.open(source);
    }
  }

  private render(): void {
    const room = online.room;
    const lobby = online.lobby;
    if (!room || !lobby || this.moving) return;
    if (lobby.map !== this.map.id) {
      // the host picked another track: the lobby again, over that map
      this.moving = true;
      void nav.onlineLobby(lobby.map);
      return;
    }
    const ranked = room.visibility === 'Ranked';
    this.settings = lobby.settings;
    const host = lobby.host === room.slot;
    const me = lobby.players.find((p) => p.slot === room.slot);
    // you first, then everyone else, then the CPUs (sharing one row)
    const others = lobby.players.filter((p) => p.slot !== room.slot);
    // joined mid-race: everyone else is still racing
    const status = (p: LobbyPlayer) => p.waiting ? 'WAITING' : me?.waiting ? 'RACING' : p.ready ? 'READY' : 'NOT READY';
    const key = JSON.stringify([lobby.players, lobby.settings, lobby.host, online.queue]);
    if (this.drivers.dataset.key !== key) {
      this.drivers.dataset.key = key;
      this.drivers.replaceChildren(
        ...(me ? [this.driverRow(carSprite(me.car), 'YOU', true, status(me))] : []),
        ...others.map((p) => this.driverRow(carSprite(p.car), p.name.toUpperCase(), false, status(p))),
        ...(lobby.settings.cpus ? [row(
          ...Array.from({ length: CPUS }, (_, i) => carIcon(cpuSprite(this.map.cpu_sprite, i))),
          h('span.grow', null, `+ ${CPUS} ${this.map.cpu_name}S`),
          pill(this.map.cpu_name, 'cpu'),
        )] : []),
      );
      this.showSettings(host && !ranked);
    }
    if (ranked) {
      const q = online.queue;
      this.ready.disabled = true;
      this.ready.textContent = q ? `Starts in ${q.seconds}` : 'Waiting';
      this.note.textContent = q && q.players < 2 ? `Waiting for other racers... (racing alone in ${q.seconds}s doesn't count)` : '';
    } else if (me?.waiting) {
      this.ready.disabled = true;
      this.ready.textContent = 'Next Race';
      this.note.textContent = "A race is on. You're in the next one";
    } else {
      this.ready.disabled = this.readyPressed;
      this.ready.textContent = this.readyPressed ? 'Waiting' : 'Ready';
      this.note.textContent = host ? '' : 'The host picks the track and the settings';
    }
  }

  protected changeSettings(settings: Settings): void {
    net.send({ Settings: settings });
  }

  protected changeTrack(mapId: string): void {
    net.send({ Map: mapId });
  }

  protected onReady(): void {
    if (this.readyPressed) return;
    this.readyPressed = true;
    net.send({ Ready: true });
    audio.play('ready', 0.5);
  }

  protected onLeave(): void {
    if (this.starting) return;
    leaveRoom();
    void nav.multiplayer();
  }

  /** the lobby redraws from what the server says */
  frame(): void {
    this.render();
  }

  dispose(): void {
    this.stop();
    this.stopClose();
  }
}
