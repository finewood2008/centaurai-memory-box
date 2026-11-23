import type {DisplayNode,DisplayEdge} from './graph.js';
export interface MotionGraph {nodes:DisplayNode[];edges:DisplayEdge[]}
export interface MotionSize {counts:Map<string,{relations:number}>;metric:'relations';max:number;autoRotate?:boolean;spatial?:boolean}
export interface GraphMotion {
  schedule(graph:MotionGraph,key:string,sizeBy:MotionSize):void;
  reset():void;
  zoom(factor:number):boolean;
  fit():boolean;
  rotate(delta:number):void;
}
export function createGraphMotion(options?:{getSvg?:()=>SVGSVGElement|null;getZoomOutput?:()=>HTMLOutputElement|null}):GraphMotion;
