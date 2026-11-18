export interface DisplayNode { id:string; name:string; type?:string; x:number; y:number; r:number; degree:number; labelWidth:number; lines:string[] }
export interface DisplayEdge { id:string; s:string; t:string }
export function layoutGraph(graph:{nodes:Array<{id:string;name:string;type?:string}>;edges:DisplayEdge[]}):{nodes:DisplayNode[];edges:DisplayEdge[]};
