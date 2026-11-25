import {
  bearer,
  check,
  connection,
  error,
  fromPath,
  matchesState,
  positiveID,
  segment,
  service,
  setting,
  stateOption,
  text,
  verdict,
  workURL,
  z,
} from '@cairul/plugin-kit';

const locator = { project: text.optional(), iid: positiveID.optional() };

export default function gitlab({ sudoUser, ...options } = {}) {
  const sudo = setting('GITLAB', 'SUDO_USER', sudoUser);
  if (sudo !== undefined) text.parse(sudo);

  const api = connection(options, {
    prefix: 'GITLAB',
    baseUrl: 'https://gitlab.com/api/v4',
    tokenEnv: (mode) => (mode === 'job-token' ? 'CI_JOB_TOKEN' : mode === 'session' ? undefined : 'GITLAB_TOKEN'),
    headers: sudo ? { sudo } : undefined,
    authModes: {
      'private-token': (token) => ({ 'private-token': token }),
      bearer,
      'job-token': (token) => ({ 'job-token': token }),
      session: (token) => {
        if (!/^[A-Za-z0-9_~.+%/=-]+$/.test(token)) throw new Error('Supply only the GitLab session cookie value.');
        return { cookie: '_gitlab_session=' + token };
      },
    },
  });

  function resource(type, inputs, evaluate) {
    return check(z.strictObject({ ...locator, ...inputs }), (config, context) =>
      service(async () => {
        let { project, iid } = config;
        if (!project || !iid) {
          const pattern =
            type === 'issues' ? /^\/(.+)\/-\/issues\/(\d+)(?:\/|$)/ : /^\/(.+)\/-\/merge_requests\/(\d+)(?:\/|$)/;
          const url = workURL(context.workItemUrl, [api.host]);
          const instancePath = api.pathname.replace(/\/api\/v4\/?$/, '');
          if (instancePath && url.pathname.startsWith(`${instancePath}/`))
            url.pathname = url.pathname.slice(instancePath.length);
          const [path, id] = fromPath(url, pattern);
          project ??= path;
          iid ??= id;
        }
        const prefix = `projects/${segment(project)}`;
        const read = (path, query) => api.request(`${prefix}/${path}`, { signal: context.signal, query });
        return evaluate(config, (suffix = '') => read(`${type}/${iid}${suffix}`), read);
      })
    );
  }

  return {
    checkKinds: {
      'gitlab.issue-state': resource('issues', { state: stateOption }, async ({ state }, read) =>
        matchesState((await read()).state, state, 'Issue')
      ),
      'gitlab.mr-merged': resource('merge_requests', {}, async (_, read) =>
        matchesState((await read()).state, 'merged', 'Merge request')
      ),
      'gitlab.mr-approved': resource('merge_requests', {}, async (_, read) => {
        const { approved } = await read('/approvals');
        if (typeof approved !== 'boolean') return error('GitLab returned no approval state.');
        return verdict(approved, approved ? 'Merge request approved.' : 'Waiting for merge request approval.');
      }),
      'gitlab.pipeline-passed': resource(
        'merge_requests',
        { pipelineId: positiveID.optional() },
        async ({ pipelineId }, mr, read) => {
          if (pipelineId) return matchesState((await read(`pipelines/${pipelineId}`)).status, 'success', 'Pipeline');
          const pipeline = (await mr()).head_pipeline;
          return pipeline
            ? matchesState(pipeline.status, 'success', 'Pipeline')
            : verdict(false, 'Waiting for a merge request pipeline.');
        }
      ),
      'gitlab.job-artifact-present': check(
        z.strictObject({ project: text, job: positiveID, filename: text.optional() }),
        ({ project, job, filename }, { signal }) =>
          service(async () => {
            const data = await api.request(`projects/${segment(project)}/jobs/${job}`, { signal });
            const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
            const names = [...artifacts.map((artifact) => artifact.filename), data.artifacts_file?.filename].filter(
              Boolean
            );
            return verdict(
              filename ? names.includes(filename) : names.length > 0,
              'Waiting for a matching job artifact.'
            );
          })
      ),
      'gitlab.pipeline-job-passed': resource(
        'merge_requests',
        { name: text, pipelineId: positiveID.optional() },
        async ({ name, pipelineId }, mr, read) => {
          const pipeline = pipelineId ?? (await mr()).head_pipeline?.id;
          if (!pipeline) return verdict(false, 'Waiting for a merge request pipeline.');
          let found = false;
          for (let page = 1; page <= 20; page++) {
            const jobs = await read(`pipelines/${positiveID.parse(pipeline)}/jobs`, { page, per_page: 100 });
            if (!Array.isArray(jobs)) return error('GitLab returned no pipeline job list.');
            for (const job of jobs.filter((item) => item.name === name)) {
              found = true;
              if (job.status !== 'success') return matchesState(job.status, 'success', 'Pipeline job');
            }
            if (jobs.length < 100)
              return verdict(found, found ? 'Pipeline job succeeded.' : `Waiting for job "${name}".`);
          }
          return error('GitLab returned too many job pages to evaluate.');
        }
      ),
    },
  };
}
