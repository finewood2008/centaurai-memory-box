import React from 'react';
import type {Project} from '../api';
import {StudioExpertDeploymentPanel} from './StudioExpertDeploymentPanel';

export function DeploymentPanel({project,scopeId}:{project:Project;scopeId:string}) {
  if(!project.workshop&&project.deploymentExpert)return <StudioExpertDeploymentPanel project={project} scopeId={scopeId}/>;
  return <section className="deployment-panel"><h2>客户端应用</h2><p>普通应用无需部署到盒子。请在采用版本后安装到客户端。</p></section>;
}
