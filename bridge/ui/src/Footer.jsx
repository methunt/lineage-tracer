import React from 'react';
import { IconLinkedin, IconGithub, IconStar, IconExternalLink } from './icons';

const REPO_URL = 'https://github.com/methunt/lineage-tracer';
const LINKEDIN_URL = 'https://www.linkedin.com/in/methunt/';
const OTHER_PROJECT_URL = 'https://github.com/methunt/PowerBi/tree/main/Bigquery%20%26%20Dbt%20Cost%20Observability';

/*
 * A credit bar, docked in the flex column rather than floated over the
 * canvas. It was `position: fixed` at first, on the theory that "fixed" is
 * what a footer that must survive scrolling needs — but this app has no page
 * scroll to survive, and floating it meant fighting every other thing that
 * also claims bottom-center of the canvas: React Flow's own depth-stepper
 * Panel sits there too, and no small offset dodges it reliably. A row in the
 * layout instead shrinks the canvas by its own height, so nothing can ever
 * sit under it — the same reason the header above the canvas doesn't need
 * `position: fixed` either. Left off the landing page on purpose — App only
 * mounts once `hasGraph` is true, and Landing is a separate overlay that
 * never renders this component.
 */
export default function Footer() {
    return (
        // Same three-column trick as the header (App.jsx): outer columns
        // equal width so the middle one sits on the bar's true centre rather
        // than the midpoint of whatever the left and right content happen
        // to measure.
        <footer className="app-footer">
            <span className="app-footer-credit">Developed by Methun</span>
            <div className="app-footer-links">
                <a href={LINKEDIN_URL} target="_blank" rel="noreferrer noopener"
                    className="app-footer-link" title="Connect on LinkedIn">
                    <IconLinkedin size="sm" />
                    <span className="app-footer-label">Connect</span>
                </a>
                <span className="app-footer-sep" />
                <a href={REPO_URL} target="_blank" rel="noreferrer noopener"
                    className="app-footer-link" title="Star this repo on GitHub">
                    <IconGithub size="sm" />
                    <IconStar size="sm" />
                    <span className="app-footer-label">Star</span>
                </a>
            </div>
            <a href={OTHER_PROJECT_URL} target="_blank" rel="noreferrer noopener"
                className="app-footer-link app-footer-other" title="BigQuery & dbt Cost Observability">
                <span className="app-footer-label">Other project: BigQuery &amp; dbt Cost Observability</span>
                <IconExternalLink size="sm" />
            </a>
        </footer>
    );
}
