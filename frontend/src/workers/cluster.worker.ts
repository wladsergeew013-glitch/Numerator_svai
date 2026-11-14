import { connectedAutoClusters } from '../store/useProjectStore';
self.onmessage = e => {
  try { self.postMessage({ result: connectedAutoClusters(e.data.points, e.data.factor).map(c => c.map(p => p.id)) }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
