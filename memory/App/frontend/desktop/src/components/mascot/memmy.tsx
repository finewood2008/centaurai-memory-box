/** Memmy module. */
import centaurMarkUrl from "../../assets/brand/centaurai-mark.png";

export type MemmyPose =
  | "wave"
  | "think"
  | "work"
  | "celebrate"
  | "shield"
  | "read"
  | "connect"
  | "sleep"
  | "neutral"
  | "point"
  | "box"
  | "brain"
  | "chat"
  | "wrench"
  | "blush"
  | "peek"
  | "hum"
  | "plead"
  | "sad";

export interface MemmyProps {
  pose?: MemmyPose;
  size?: number;
  className?: string;
}

export interface MemmyAssetPreloadOptions {
  createImage?: () => HTMLImageElement;
}

export function preloadMemmyAsset(src: string, options: MemmyAssetPreloadOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = options.createImage?.() ?? new Image();

    image.onload = () => resolve(src);
    image.onerror = () => reject(new Error(`Failed to preload Memmy asset: ${src}`));
    image.src = src;
  });
}

/**
 * Render the Memmy artwork and preload the target image before switching poses.
 *
 * @param props the Memmy display props.
 * @returns an img element.
 */
export function Memmy({ size = 100, className = "" }: MemmyProps) {
  return <img src={centaurMarkUrl} alt="" className={className} draggable={false}
    style={{ width: size, height: "auto", userSelect: "none", display: "inline-block" }} />;
}
