import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';

const BAR_COUNT = 8;
const GAP_DEG = 68;
const ARC_SPAN = 360 - GAP_DEG;
const ARC_START = GAP_DEG / 2;
const BAR_OPACITIES = [0.15, 0.25, 0.35, 0.5, 0.65, 0.78, 0.88, 1];
const REV_MS = 920;

function barAngles(): number[] {
  const step = ARC_SPAN / (BAR_COUNT - 1);
  return Array.from({ length: BAR_COUNT }, (_, i) => ARC_START + step * i);
}

function useSpinnerRotation(active = true): number {
  const [angle, setAngle] = useState(0);
  const angleRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = Date.now();
    const degPerSec = 360 / (REV_MS / 1000);

    const tick = () => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      let next = angleRef.current + degPerSec * dt;
      if (next >= 360) next -= 360;
      angleRef.current = next;
      setAngle(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return angle;
}

/** Matches dashboard OrbThinkingSpinner — open arc, waveform color, ~52% of orb. */
export function OrbThinkingSpinner({ orbSizePx, color }: { orbSizePx: number; color: string }) {
  const size = Math.max(32, orbSizePx * 0.52);
  const angle = useSpinnerRotation();
  const angles = barAngles();

  return (
    <View
      style={{
        width: size,
        height: size,
        transform: [{ rotate: `${angle}deg` }],
      }}
    >
      <Svg width={size} height={size} viewBox="0 0 40 40">
        {angles.map((barAngle, i) => (
          <Rect
            key={i}
            x="18.25"
            y="5.5"
            width="3.5"
            height="11"
            rx="1.75"
            fill={color}
            opacity={BAR_OPACITIES[i]}
            transform={`rotate(${barAngle}, 20, 20)`}
          />
        ))}
      </Svg>
    </View>
  );
}
