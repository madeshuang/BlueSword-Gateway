"""URDF forward kinematics + display-only arm IK (never sent to real GDK)."""
import math
import xml.etree.ElementTree as ET

import numpy as np


def vector(element, attr, default="0 0 0"):
    return np.array([float(x) for x in element.get(attr, default).split()]) if element is not None else np.array([float(x) for x in default.split()])


def axis_rotation(axis, angle):
    axis = np.asarray(axis, dtype=float)
    axis = axis / max(np.linalg.norm(axis), 1e-12)
    x, y, z = axis
    skew = np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]])
    result = np.eye(4)
    result[:3, :3] = np.eye(3)+math.sin(angle)*skew+(1-math.cos(angle))*(skew @ skew)
    return result


def origin(element):
    xyz, rpy = vector(element, "xyz"), vector(element, "rpy")
    result = axis_rotation([0, 0, 1], rpy[2]) @ axis_rotation([0, 1, 0], rpy[1]) @ axis_rotation([1, 0, 0], rpy[0])
    result[:3, 3] = xyz
    return result


class Model:
    def __init__(self, path):
        self.xml = ET.parse(path).getroot()
        self.links = {node.get("name"): node for node in self.xml.findall("link")}
        self.joints = []
        self.parent_joint = {}
        for node in self.xml.findall("joint"):
            limit = node.find("limit")
            data = {"name": node.get("name"), "type": node.get("type"),
                    "parent": node.find("parent").get("link"), "child": node.find("child").get("link"),
                    "origin": origin(node.find("origin")), "axis": vector(node.find("axis"), "xyz", "1 0 0"),
                    "low": float(limit.get("lower", -math.pi)) if limit is not None else -math.pi,
                    "high": float(limit.get("upper", math.pi)) if limit is not None else math.pi,
                    "mimic": node.find("mimic")}
            self.joints.append(data)
            self.parent_joint[data["child"]] = data
        self.root = next(name for name in self.links if name not in self.parent_joint)
        self.q = {joint["name"]: 0.0 for joint in self.joints}
        for side in ("l", "r"):
            chain = [j for j in self.joints if f"_arm_{side}_joint" in j["name"]]
            for joint, value in zip(chain, [-.6, -.8, 0, -1.5, 0, 0, 0]):
                self.q[joint["name"]] = value
        self.positions = {}

    def fk(self):
        transforms = {self.root: np.eye(4)}
        frames = {}
        pending = list(self.joints)
        while pending:
            progress = False
            for joint in pending[:]:
                if joint["parent"] not in transforms:
                    continue
                t = transforms[joint["parent"]] @ joint["origin"]
                frames[joint["name"]] = t
                q = self.q[joint["name"]]
                mimic = joint["mimic"]
                if mimic is not None:
                    q = self.q[mimic.get("joint")] * float(mimic.get("multiplier", 1)) + float(mimic.get("offset", 0))
                if joint["type"] in {"revolute", "continuous"}:
                    t = t @ axis_rotation(joint["axis"], q)
                elif joint["type"] == "prismatic":
                    motion = np.eye(4)
                    motion[:3, 3] = joint["axis"] * q
                    t = t @ motion
                transforms[joint["child"]] = t
                pending.remove(joint)
                progress = True
            if not progress:
                raise ValueError("Invalid URDF joint tree")
        return transforms, frames

    def solve(self, side, target, iterations=40):
        link = f"gripper_{side}_base_link"
        chain = []
        current = link
        while current in self.parent_joint:
            joint = self.parent_joint[current]
            if f"_arm_{side}_joint" in joint["name"]:
                chain.insert(0, joint)
            current = joint["parent"]
        tip = np.array([0.0, 0.0, 0.19, 1.0])
        desired = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], dtype=float)
        for _ in range(iterations):
            transforms, frames = self.fk()
            end = transforms[link]
            position = (end @ tip)[:3]
            error = np.asarray(target)-position
            angular = sum(np.cross(end[:3, i], desired[:, i]) for i in range(3))*0.5
            if np.linalg.norm(error) < 0.002 and np.linalg.norm(angular) < 0.05:
                break
            jacobian = np.zeros((6, len(chain)))
            for i, joint in enumerate(chain):
                frame = frames[joint["name"]]
                axis = frame[:3, :3] @ joint["axis"]
                jacobian[:3, i] = np.cross(axis, position-frame[:3, 3])
                jacobian[3:, i] = axis*0.03
            residual = np.r_[error, angular*0.03]
            update = jacobian.T @ np.linalg.solve(jacobian @ jacobian.T + np.eye(6)*0.001, residual)
            for joint, delta in zip(chain, update):
                self.q[joint["name"]] = float(np.clip(self.q[joint["name"]]+np.clip(delta, -0.18, 0.18), joint["low"], joint["high"]))
        transforms, _ = self.fk()
        actual = (transforms[link] @ tip)[:3]
        return float(np.linalg.norm(actual-np.asarray(target)))
