import {layoutGraph} from '../../ui/graph.js';
import type {NetworkNode,NetworkLink} from './components/PointLineGraph';

// Presentation coordinates only; original type identities and relation directions stay on the links.
export function ontologySpatialGraph(nodes:NetworkNode[],links:NetworkLink[],focusNode?:string) {
  const graph=layoutGraph({nodes:nodes.map(node=>({id:node.id,name:node.label,type:node.type})),
    edges:links.map(link=>({id:JSON.stringify([link.source,link.target]),s:link.source,t:link.target}))});
  const focused=focusNode&&graph.nodes.some(node=>node.id===focusNode);
  if(focused||graph.nodes.length>=5){
    const neighbors=graph.nodes.filter(node=>!focused||node.id!==focusNode);
    const radiusX=Math.max(360,neighbors.length*14),radiusY=Math.max(230,neighbors.length*10);
    for(const node of graph.nodes){
      const angle=neighbors.findIndex(n=>n.id===node.id)/Math.max(1,neighbors.length)*Math.PI*2-Math.PI/2;
      node.x=focused&&node.id===focusNode?460:460+radiusX*Math.cos(angle);
      node.y=focused&&node.id===focusNode?280:280+radiusY*Math.sin(angle);
    }
  }
  // Give each type its own motion group so dense cross-type springs do not
  // collapse the readable overview after a node is dragged.
  return {...graph,nodes:graph.nodes.map(node=>({...node,constellation:node.id}))};
}
