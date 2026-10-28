import {
  interpolateRdBu,
  interpolateSpectral,
  interpolateViridis,
  interpolateGreys,
} from "d3";
export const COLOR_SCHEMES = [
  { value: "redblue", label: "Red–blue" },
  { value: "spectral", label: "Spectral" },
  { value: "viridis", label: "Viridis" },
  { value: "mono", label: "Monochrome" },
];
export function historyColor(scheme, ageFraction) {
  const t = Math.max(0, Math.min(1, ageFraction));
  return (
    {
      redblue: (u) => interpolateRdBu(1 - u),
      spectral: (u) => interpolateSpectral(1 - u),
      viridis: interpolateViridis,
      mono: (u) => interpolateGreys(0.75 - u * 0.5),
    }[scheme] || interpolateViridis
  )(t);
}
