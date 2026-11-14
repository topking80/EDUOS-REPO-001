#!/usr/bin/env python3
"""
EduOS Architecture Diagram Generator
Creates clean, professional diagrams for the PDF dossier.
"""

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Circle, Rectangle
import numpy as np
import os

OUTPUT_DIR = "/home/workdir/artifacts/eduos/docs/diagrams"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Consistent styling
plt.rcParams['font.family'] = 'DejaVu Sans'
plt.rcParams['font.size'] = 10
COLORS = {
    'primary': '#1a365d',      # Deep navy
    'secondary': '#2c5282',    # Medium blue
    'accent': '#3182ce',       # Bright blue
    'success': '#38a169',      # Green
    'warning': '#d69e2e',      # Gold
    'light': '#e2e8f0',        # Light gray
    'white': '#ffffff',
    'dark': '#1a202c',
    'student': '#e53e3e',      # Red for student
    'teacher': '#3182ce',      # Blue
    'admin': '#805ad5',        # Purple
    'edge': '#38a169',         # Green
    'district': '#dd6b20',     # Orange
    'state': '#c53030',        # Dark red
}

def create_architecture_overview():
    """High-level system architecture diagram"""
    fig, ax = plt.subplots(1, 1, figsize=(11, 8.5))
    ax.set_xlim(0, 11)
    ax.set_ylim(0, 8.5)
    ax.axis('off')
    
    # Title
    ax.text(5.5, 8.1, "EduOS System Architecture", fontsize=16, fontweight='bold', 
            ha='center', va='center', color=COLORS['primary'])
    ax.text(5.5, 7.7, "Cislunar? No — Classroom to State Education Department", 
            fontsize=9, ha='center', va='center', color=COLORS['secondary'], style='italic')
    
    # State layer (top)
    rect_state = FancyBboxPatch((3.5, 6.2), 4, 1.1, boxstyle="round,pad=0.05,rounding_size=0.2",
                                 facecolor=COLORS['state'], edgecolor='white', linewidth=2, alpha=0.9)
    ax.add_patch(rect_state)
    ax.text(5.5, 6.75, "STATE EDUCATION\nDEPARTMENT", fontsize=9, fontweight='bold', 
            ha='center', va='center', color='white')
    
    # District layer
    rect_dist = FancyBboxPatch((2.5, 4.6), 6, 1.1, boxstyle="round,pad=0.05,rounding_size=0.2",
                                facecolor=COLORS['district'], edgecolor='white', linewidth=2, alpha=0.9)
    ax.add_patch(rect_dist)
    ax.text(5.5, 5.15, "DISTRICT CONTROL PLANE\n(Fleet Management • Policy • Aggregation)", 
            fontsize=8, fontweight='bold', ha='center', va='center', color='white')
    
    # Edge / School layer
    rect_edge = FancyBboxPatch((0.8, 2.8), 9.4, 1.3, boxstyle="round,pad=0.05,rounding_size=0.2",
                                facecolor=COLORS['edge'], edgecolor='white', linewidth=2, alpha=0.85)
    ax.add_patch(rect_edge)
    ax.text(5.5, 3.75, "SCHOOL / BUILDING EDGE", fontsize=9, fontweight='bold', 
            ha='center', va='center', color='white')
    ax.text(5.5, 3.25, "Classroom Hubs • Local Cache • PXE Boot • Offline Capable", 
            fontsize=7, ha='center', va='center', color='white', alpha=0.9)
    
    # Device layer (bottom) - role boxes
    roles = [
        ("STUDENT\nKiosk / Locked", COLORS['student'], 1.3),
        ("TEACHER\nManagement", COLORS['teacher'], 3.5),
        ("ADMIN\nIT / School", COLORS['admin'], 5.7),
    ]
    
    for label, color, x in roles:
        rect = FancyBboxPatch((x, 0.8), 1.8, 1.4, boxstyle="round,pad=0.03,rounding_size=0.15",
                              facecolor=color, edgecolor='white', linewidth=1.5, alpha=0.9)
        ax.add_patch(rect)
        ax.text(x + 0.9, 1.5, label, fontsize=7, fontweight='bold', 
                ha='center', va='center', color='white')
    
    # Arrows / connections
    arrow_style = dict(arrowstyle='->', color=COLORS['primary'], lw=1.5, mutation_scale=12)
    ax.annotate('', xy=(5.5, 6.2), xytext=(5.5, 5.7), arrowprops=arrow_style)
    ax.annotate('', xy=(5.5, 4.6), xytext=(5.5, 4.1), arrowprops=arrow_style)
    
    # Legend
    ax.text(0.5, 0.3, "Legend:", fontsize=8, fontweight='bold', color=COLORS['dark'])
    ax.add_patch(Rectangle((1.3, 0.2), 0.3, 0.2, facecolor=COLORS['state']))
    ax.text(1.7, 0.3, "State", fontsize=7, va='center')
    ax.add_patch(Rectangle((2.5, 0.2), 0.3, 0.2, facecolor=COLORS['district']))
    ax.text(2.9, 0.3, "District", fontsize=7, va='center')
    ax.add_patch(Rectangle((3.8, 0.2), 0.3, 0.2, facecolor=COLORS['edge']))
    ax.text(4.2, 0.3, "Edge", fontsize=7, va='center')
    ax.add_patch(Rectangle((5.0, 0.2), 0.3, 0.2, facecolor=COLORS['student']))
    ax.text(5.4, 0.3, "Student", fontsize=7, va='center')
    
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/01_architecture_overview.png", dpi=150, bbox_inches='tight', 
                facecolor='white', edgecolor='none')
    plt.close()
    print("Created: 01_architecture_overview.png")


def create_role_comparison():
    """Role capabilities comparison diagram"""
    fig, ax = plt.subplots(figsize=(11, 7))
    ax.axis('off')
    
    ax.text(5.5, 6.7, "EduOS Role Capabilities Matrix", fontsize=14, fontweight='bold', 
            ha='center', color=COLORS['primary'])
    
    # Table-like structure
    roles_data = [
        ("Role", "Access Level", "Key Capabilities", "Typical Hardware"),
        ("Student", "Restricted", "Kiosk mode, web apps, enrolled devices only", "Chromebooks, thin clients, old PCs"),
        ("Teacher", "Elevated", "Enrollment portal, lesson tools, local management", "Laptops, classroom PCs"),
        ("Admin", "High", "Full local admin, fleet tools, diagnostics", "Admin workstations, servers"),
        ("Edge", "Service", "Local cache, PXE, offline sync, classroom hub", "NUC, Raspberry Pi 5, mini-PC"),
        ("District", "Orchestration", "Policy engine, update control, aggregation", "On-prem or cloud VM cluster"),
        ("State", "Oversight", "Regional dashboards, compliance reporting", "Centralized state infrastructure"),
    ]
    
    y_start = 6.0
    row_height = 0.75
    col_widths = [1.4, 1.6, 4.5, 3.0]
    x_positions = [0.5]
    for w in col_widths[:-1]:
        x_positions.append(x_positions[-1] + w)
    
    for i, row in enumerate(roles_data):
        y = y_start - i * row_height
        for j, (cell, x, w) in enumerate(zip(row, x_positions, col_widths)):
            if i == 0:  # Header
                rect = FancyBboxPatch((x, y - 0.35), w - 0.05, 0.65, 
                                      boxstyle="round,pad=0.02", facecolor=COLORS['primary'], 
                                      edgecolor='white', linewidth=1)
                ax.add_patch(rect)
                color = 'white'
                weight = 'bold'
            else:
                bg_color = COLORS['light'] if i % 2 == 0 else 'white'
                rect = FancyBboxPatch((x, y - 0.35), w - 0.05, 0.65,
                                      boxstyle="round,pad=0.01", facecolor=bg_color,
                                      edgecolor=COLORS['secondary'], linewidth=0.5, alpha=0.7)
                ax.add_patch(rect)
                color = COLORS['dark']
                weight = 'normal'
            
            ax.text(x + w/2 - 0.025, y, cell, fontsize=7.5, ha='center', va='center',
                    color=color, fontweight=weight, wrap=True)
    
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/02_role_matrix.png", dpi=150, bbox_inches='tight', facecolor='white')
    plt.close()
    print("Created: 02_role_matrix.png")


def create_service_flow():
    """Core services interaction diagram"""
    fig, ax = plt.subplots(figsize=(10, 7))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 7)
    ax.axis('off')
    
    ax.text(5, 6.7, "EduOS Core Services — Data & Control Flow", fontsize=14, fontweight='bold',
            ha='center', color=COLORS['primary'])
    
    # Service boxes
    services = [
        ("BOOTSTRAP", "First-boot identity\n& registration", COLORS['accent'], 1.5, 4.8),
        ("ENROLLMENT", "Device / User\nonboarding portal", COLORS['success'], 5, 4.8),
        ("HEALTH", "Telemetry &\ncompliance agent", COLORS['warning'], 8.5, 4.8),
        ("UPDATE", "Policy-driven\natomic updates", COLORS['secondary'], 5, 2.2),
    ]
    
    for name, desc, color, x, y in services:
        rect = FancyBboxPatch((x-1.3, y-0.9), 2.6, 1.8, boxstyle="round,pad=0.05",
                              facecolor=color, edgecolor='white', linewidth=2, alpha=0.85)
        ax.add_patch(rect)
        ax.text(x, y + 0.3, name, fontsize=9, fontweight='bold', ha='center', va='center', color='white')
        ax.text(x, y - 0.35, desc, fontsize=7, ha='center', va='center', color='white', alpha=0.95)
    
    # Arrows showing flow
    arrow_props = dict(arrowstyle='->', color=COLORS['dark'], lw=1.8, mutation_scale=15)
    
    # Bootstrap -> others
    ax.annotate('', xy=(3.7, 4.8), xytext=(2.8, 4.8), arrowprops=arrow_props)
    ax.annotate('', xy=(7.2, 4.8), xytext=(6.3, 4.8), arrowprops=arrow_props)
    
    # Health <-> Update bidirectional
    ax.annotate('', xy=(6.3, 3.1), xytext=(7.2, 3.9), arrowprops=dict(arrowstyle='<->', color=COLORS['dark'], lw=1.5))
    
    # Enrollment triggers
    ax.annotate('', xy=(5, 3.1), xytext=(5, 3.9), arrowprops=arrow_props)
    
    # Legend / notes
    ax.text(5, 0.8, "All services run as systemd units (or Quadlets). Health & Update agents run continuously.\n"
            "Bootstrap runs once. Enrollment provides local web UI for teachers/admins.", 
            fontsize=7.5, ha='center', va='center', style='italic', color=COLORS['secondary'])
    
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/03_service_flow.png", dpi=150, bbox_inches='tight', facecolor='white')
    plt.close()
    print("Created: 03_service_flow.png")


def create_deployment_options():
    """Deployment workflow diagram"""
    fig, ax = plt.subplots(figsize=(11, 6))
    ax.set_xlim(0, 11)
    ax.set_ylim(0, 6)
    ax.axis('off')
    
    ax.text(5.5, 5.7, "EduOS Deployment Options", fontsize=14, fontweight='bold', 
            ha='center', color=COLORS['primary'])
    
    options = [
        ("USB / USB-C\nBootable Media", "dd or balenaEtcher\n→ Target device", 1.8, 3.8, COLORS['accent']),
        ("PXE / iPXE\nNetwork Boot", "Matchbox or\nFedora CoreOS PXE", 5.5, 3.8, COLORS['success']),
        ("Air-Gapped\n(Offline)", "Pre-embedded Ignition\n+ USB sneaker-net", 9.2, 3.8, COLORS['warning']),
    ]
    
    for title, desc, x, y, color in options:
        # Box
        rect = FancyBboxPatch((x-1.5, y-1.2), 3, 2.4, boxstyle="round,pad=0.08",
                              facecolor=color, edgecolor='white', linewidth=2, alpha=0.85)
        ax.add_patch(rect)
        ax.text(x, y + 0.5, title, fontsize=9, fontweight='bold', ha='center', va='center', color='white')
        ax.text(x, y - 0.4, desc, fontsize=7.5, ha='center', va='center', color='white', alpha=0.95)
    
    # Bottom note
    ax.text(5.5, 1.2, "All methods support role-specific Ignition configs. Air-gapped mode is first-class for security-sensitive districts.",
            fontsize=8, ha='center', va='center', style='italic', color=COLORS['secondary'])
    
    # Arrows between options
    ax.annotate('', xy=(4.0, 3.8), xytext=(3.3, 3.8), arrowprops=dict(arrowstyle='->', color=COLORS['dark'], lw=1.5))
    ax.annotate('', xy=(7.7, 3.8), xytext=(7.0, 3.8), arrowprops=dict(arrowstyle='->', color=COLORS['dark'], lw=1.5))
    
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/04_deployment.png", dpi=150, bbox_inches='tight', facecolor='white')
    plt.close()
    print("Created: 04_deployment.png")


if __name__ == "__main__":
    print("Generating EduOS architecture diagrams...")
    create_architecture_overview()
    create_role_comparison()
    create_service_flow()
    create_deployment_options()
    print("\nAll diagrams generated successfully in", OUTPUT_DIR)
