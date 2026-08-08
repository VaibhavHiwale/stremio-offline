// Minimal Stremio addon protocol types — only the shapes this addon actually
// emits. Not a full SDK type port.

export interface ManifestCatalog {
  type: string;
  id: string;
  name: string;
  extra?: { name: string; isRequired?: boolean; options?: string[] }[];
}

export interface Manifest {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: string[];
  types: string[];
  catalogs: ManifestCatalog[];
  behaviorHints?: {
    configurable?: boolean;
    configurationRequired?: boolean;
  };
}

export interface MetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  releaseInfo?: string;
}

export interface Video {
  id: string; // "tt0903747:1:1"
  title: string;
  season?: number;
  episode?: number;
  released?: string;
}

export interface Meta extends MetaPreview {
  videos?: Video[];
}

export interface CatalogResponse {
  metas: MetaPreview[];
}

export interface MetaResponse {
  meta: Meta;
}

export interface StreamBehaviorHints {
  notWebReady?: boolean;
  bingeGroup?: string;
  filename?: string;
}

export interface StreamEntry {
  name?: string;
  title?: string;
  url?: string;
  behaviorHints?: StreamBehaviorHints;
}

export interface StreamResponse {
  streams: StreamEntry[];
}

export interface SubtitleEntry {
  id: string;
  url: string;
  lang: string;
}

export interface SubtitlesResponse {
  subtitles: SubtitleEntry[];
}
