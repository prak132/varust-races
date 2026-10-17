// VAR Races: loads the look, the simulation and the title screen.
import { app } from './app';
import { loadSim } from './wasm';
import { loadTheme } from './theme';
import { nav } from './nav';

async function boot(): Promise<void> {
  // the menu's code comes in alongside, rather than after
  await Promise.all([loadTheme(), loadSim(), import('./ui/menu')]);
  app.start();
  await nav.menu();
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('ui')!.textContent = 'Sorry, the game could not start in this browser.';
});
